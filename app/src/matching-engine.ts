import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { Program, BN, AnchorProvider } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const IDL = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../shadowdex/target/idl/shadowdex.json"),
    "utf-8"
  )
);

// ── Connections ───────────────────────────────────────────────────────────────
const baseConnection   = new Connection(process.env.SOLANA_RPC!,    "confirmed");
const rollupConnection = new Connection(process.env.MAGICBLOCK_RPC!, "confirmed");

// ── Wallet ────────────────────────────────────────────────────────────────────
function loadWallet(): Keypair {
  const raw = fs.readFileSync(
    process.env.ANCHOR_WALLET!.replace("~", process.env.HOME!),
    "utf-8"
  );
  return Keypair.fromSecretKey(Buffer.from(JSON.parse(raw)));
}

function makeProvider(connection: Connection, wallet: Keypair): AnchorProvider {
  return new AnchorProvider(
    connection,
    {
      publicKey: wallet.publicKey,
      signTransaction: async (tx) => { tx.sign(wallet); return tx; },
      signAllTransactions: async (txs) => { txs.forEach(t => t.sign(wallet)); return txs; },
    },
    { commitment: "confirmed" }
  );
}

// ── Order types ───────────────────────────────────────────────────────────────
interface LiveOrder {
  publicKey: PublicKey;
  orderId:   number;
  owner:     PublicKey;
  side:      "buy" | "sell";
  price:     number;
  size:      number;
  filled:    number;
  timestamp: number;
}

// ── In-memory order book ──────────────────────────────────────────────────────
const buys:  LiveOrder[] = [];
const sells: LiveOrder[] = [];

const trades: {
  buyOrderId:  number;
  sellOrderId: number;
  fillPrice:   number;
  fillSize:    number;
  buyer:       string;
  seller:      string;
  ts:          number;
}[] = [];

// ── Fetch all open orders from chain ─────────────────────────────────────────
async function syncOrderBook(program: Program): Promise<void> {
  const allOrders = await program.account.order.all();

  buys.length  = 0;
  sells.length = 0;

  for (const { publicKey, account } of allOrders) {
    const acc = account as any;

    // Only open orders
    if (!acc.status.open) continue;

    const order: LiveOrder = {
      publicKey,
      orderId:   acc.orderId.toNumber(),
      owner:     acc.owner,
      side:      acc.side.buy !== undefined ? "buy" : "sell",
      price:     acc.price.toNumber(),
      size:      acc.size.toNumber(),
      filled:    acc.filled.toNumber(),
      timestamp: acc.timestamp.toNumber(),
    };

    if (order.side === "buy")  buys.push(order);
    else                       sells.push(order);
  }

  // Sort: buys descending by price (best bid first), sells ascending (best ask first)
  buys.sort((a, b)  => b.price - a.price || a.timestamp - b.timestamp);
  sells.sort((a, b) => a.price - b.price || a.timestamp - b.timestamp);

  console.log(`Order book synced — ${buys.length} bids / ${sells.length} asks`);
}

// ── Match engine (price-time priority) ───────────────────────────────────────
function findMatches(): { buy: LiveOrder; sell: LiveOrder; fillPrice: number; fillSize: number }[] {
  const matches = [];

  for (const buy of buys) {
    for (const sell of sells) {
      if (buy.price >= sell.price) {
        const fillPrice = sell.price; // sell side sets the price (passive)
        const fillSize  = Math.min(
          buy.size  - buy.filled,
          sell.size - sell.filled
        );
        if (fillSize > 0) {
          matches.push({ buy, sell, fillPrice, fillSize });
        }
      }
    }
  }

  return matches;
}

// ── Settle matches on-chain ───────────────────────────────────────────────────
async function settleMatches(
  program: Program,
  matcher: Keypair,
  matches: ReturnType<typeof findMatches>
): Promise<void> {
  for (const { buy, sell, fillPrice, fillSize } of matches) {
    try {
      console.log(
        `Settling: buy#${buy.orderId} x sell#${sell.orderId} ` +
        `@ ${fillPrice} size=${fillSize}` 
      );

      const sig = await program.methods
        .settleMatch(
          new BN(buy.orderId),
          new BN(sell.orderId),
          new BN(fillPrice),
          new BN(fillSize)
        )
        .accounts({
          buyOrder:  buy.publicKey,
          sellOrder: sell.publicKey,
          matcher:   matcher.publicKey,
        })
        .signers([matcher])
        .rpc();

      trades.push({
        buyOrderId:  buy.orderId,
        sellOrderId: sell.orderId,
        fillPrice,
        fillSize,
        buyer:  buy.owner.toBase58(),
        seller: sell.owner.toBase58(),
        ts:     Date.now(),
      });

      console.log(`Settled ✓  sig: ${sig}`);
      console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);

    } catch (e: any) {
      console.error(`Failed to settle buy#${buy.orderId} x sell#${sell.orderId}:`, e.message);
    }
  }
}

// ── Print order book state ────────────────────────────────────────────────────
function printBook(): void {
  console.log("\n── Order Book ──────────────────────────────────");
  console.log("BIDS (buy):");
  buys.forEach(o  => console.log(`  #${o.orderId}  price=${o.price}  size=${o.size - o.filled} remaining`));
  console.log("ASKS (sell):");
  sells.forEach(o => console.log(`  #${o.orderId}  price=${o.price}  size=${o.size - o.filled} remaining`));
  console.log("Recent trades:");
  trades.slice(-5).forEach(t =>
    console.log(`  buy#${t.buyOrderId} x sell#${t.sellOrderId} @ ${t.fillPrice} x ${t.fillSize}`)
  );
  console.log("────────────────────────────────────────────────\n");
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const wallet   = loadWallet();
  const provider = makeProvider(baseConnection, wallet);
  const program  = new Program(IDL as any, provider);

  console.log("ShadowDEX matching engine started");
  console.log("Matcher:", wallet.publicKey.toBase58());

  // Poll every 2 seconds
  while (true) {
    try {
      await syncOrderBook(program);
      const matches = findMatches();

      if (matches.length > 0) {
        console.log(`Found ${matches.length} match(es) — settling...`);
        await settleMatches(program, wallet, matches);
      }

      printBook();
    } catch (e: any) {
      console.error("Engine error:", e.message);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(console.error);
