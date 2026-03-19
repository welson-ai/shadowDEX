import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN, web3 } from "@coral-xyz/anchor";
import {
  EphemeralRollup,
  delegateAccount,
  undelegateAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

// ── IDL (paste full IDL from target/idl/shadowdex.json after build) ───────────
const IDL = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../shadowdex/target/idl/shadowdex.json"),
    "utf-8"
  )
);

// ── Constants ─────────────────────────────────────────────────────────────────
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID!);
export const SOLANA_RPC  = process.env.SOLANA_RPC!;
export const MB_RPC      = process.env.MAGICBLOCK_RPC!;

// ── Connections ───────────────────────────────────────────────────────────────
export const baseConnection      = new Connection(SOLANA_RPC, "confirmed");
export const rollupConnection    = new Connection(MB_RPC,     "confirmed");

// ── Wallet (matcher keypair — this becomes the TEE session authority) ─────────
export function loadWallet(): Keypair {
  const raw = fs.readFileSync(
    process.env.ANCHOR_WALLET!.replace("~", process.env.HOME!),
    "utf-8"
  );
  return Keypair.fromSecretKey(Buffer.from(JSON.parse(raw)));
}

// ── Providers ─────────────────────────────────────────────────────────────────
export function getBaseProvider(wallet: Keypair): AnchorProvider {
  return new AnchorProvider(
    baseConnection,
    { publicKey: wallet.publicKey, signTransaction: async (tx) => { tx.sign(wallet); return tx; }, signAllTransactions: async (txs) => { txs.forEach(t => t.sign(wallet)); return txs; } },
    { commitment: "confirmed" }
  );
}

export function getRollupProvider(wallet: Keypair): AnchorProvider {
  return new AnchorProvider(
    rollupConnection,
    { publicKey: wallet.publicKey, signTransaction: async (tx) => { tx.sign(wallet); return tx; }, signAllTransactions: async (txs) => { txs.forEach(t => t.sign(wallet)); return txs; } },
    { commitment: "confirmed" }
  );
}

// ── PDA helpers ───────────────────────────────────────────────────────────────
export function orderPDA(owner: PublicKey, orderId: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("order"),
      owner.toBuffer(),
      Buffer.from(new BN(orderId).toArray("le", 8)),
    ],
    PROGRAM_ID
  );
  return pda;
}

// ── Delegate an order account into the private ephemeral rollup ───────────────
export async function delegateOrderToRollup(
  wallet: Keypair,
  orderAccount: PublicKey
): Promise<string> {
  console.log(`Delegating order account ${orderAccount.toBase58()} to rollup...`);

  const tx = await delegateAccount({
    payer:      wallet.publicKey,
    account:    orderAccount,
    ownerProgram: PROGRAM_ID,
    connection: baseConnection,
  });

  const sig = await baseConnection.sendTransaction(tx, [wallet]);
  await baseConnection.confirmTransaction(sig, "confirmed");
  console.log(`Delegated ✓  sig: ${sig}`);
  return sig;
}

// ── Undelegate (settle back to base layer) ────────────────────────────────────
export async function undelegateOrderFromRollup(
  wallet: Keypair,
  orderAccount: PublicKey
): Promise<string> {
  console.log(`Undelegating ${orderAccount.toBase58()} back to Solana...`);

  const tx = await undelegateAccount({
    payer:      wallet.publicKey,
    account:    orderAccount,
    ownerProgram: PROGRAM_ID,
    connection: rollupConnection,
  });

  const sig = await rollupConnection.sendTransaction(tx, [wallet]);
  await rollupConnection.confirmTransaction(sig, "confirmed");
  console.log(`Undelegated ✓  sig: ${sig}`);
  return sig;
}

// ── Submit order (to rollup, invisible on public mempool) ─────────────────────
export async function submitOrder(
  wallet: Keypair,
  orderId: number,
  side: { buy?: {} } | { sell?: {} },
  price: number,
  size: number
): Promise<{ orderAccount: PublicKey; sig: string }> {
  const provider = getRollupProvider(wallet);
  const program = new Program(IDL as any, provider);
  const orderAccount = orderPDA(wallet.publicKey, orderId);

  const sig = await program.methods
    .submitOrder(new BN(orderId), side, new BN(price), new BN(size))
    .accounts({
      order:         orderAccount,
      user:          wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  console.log(`Order ${orderId} submitted to rollup ✓  sig: ${sig}`);
  return { orderAccount, sig };
}

// ── Settle a matched pair (called by matching engine) ─────────────────────────
export async function settleMatch(
  matcher: Keypair,
  buyOrderAccount: PublicKey,
  sellOrderAccount: PublicKey,
  buyOrderId: number,
  sellOrderId: number,
  fillPrice: number,
  fillSize: number
): Promise<string> {
  const provider = getRollupProvider(matcher);
  const program = new Program(IDL as any, provider);

  const sig = await program.methods
    .settleMatch(
      new BN(buyOrderId),
      new BN(sellOrderId),
      new BN(fillPrice),
      new BN(fillSize)
    )
    .accounts({
      buyOrder:  buyOrderAccount,
      sellOrder: sellOrderAccount,
      matcher:   matcher.publicKey,
    })
    .signers([matcher])
    .rpc();

  console.log(`Match settled ✓  buy#${buyOrderId} x sell#${sellOrderId}  @ ${fillPrice}  sig: ${sig}`);
  return sig;
}
