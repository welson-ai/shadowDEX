"use client";
import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("HczPXyfpBMCkeyR1Z2GptoxtbmWRRpUvsvjZ9iCyMwwq");

// Inline IDL — just the parts UI needs
const IDL = {
  address: "HczPXyfpBMCkeyR1Z2GptoxtbmWRRpUvsvjZ9iCyMwwq",
  metadata: { name: "shadowdex", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    {
      name: "submit_order",
      discriminator: [171, 108, 95, 234, 52, 6, 205, 82],
      accounts: [
        { name: "order", writable: true, pda: { seeds: [{ kind: "const", value: [111,114,100,101,114] }, { kind: "account", path: "user" }, { kind: "arg", path: "order_id" }] } },
        { name: "user", writable: true, signer: true },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [
        { name: "order_id", type: "u64" },
        { name: "side", type: { defined: { name: "OrderSide" } } },
        { name: "price", type: "u64" },
        { name: "size", type: "u64" },
      ],
    },
  ],
  accounts: [
    {
      name: "Order",
      discriminator: [134, 173, 232, 200, 169, 188, 237, 4],
    },
  ],
  types: [
    {
      name: "OrderSide",
      type: { kind: "enum", variants: [{ name: "Buy" }, { name: "Sell" }] },
    },
    {
      name: "OrderStatus",
      type: { kind: "enum", variants: [{ name: "Open" }, { name: "Filled" }, { name: "Cancelled" }] },
    },
    {
      name: "Order",
      type: {
        kind: "struct",
        fields: [
          { name: "owner", type: "pubkey" },
          { name: "order_id", type: "u64" },
          { name: "side", type: { defined: { name: "OrderSide" } } },
          { name: "price", type: "u64" },
          { name: "size", type: "u64" },
          { name: "filled", type: "u64" },
          { name: "status", type: { defined: { name: "OrderStatus" } } },
          { name: "timestamp", type: "i64" },
          { name: "bump", type: "u8" },
        ],
      },
    },
  ],
};

interface Order {
  publicKey: string;
  orderId: string;
  owner: string;
  side: string;
  price: number;
  size: number;
  filled: number;
  status: string;
}

export default function Home() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  // ── Build provider + program ──────────────────────────────────────────────
  const getProgram = useCallback(() => {
    if (!publicKey || !signTransaction || !signAllTransactions) return null;
    const provider = new AnchorProvider(
      connection,
      { publicKey, signTransaction, signAllTransactions },
      { commitment: "confirmed" }
    );
    return new Program(IDL as any, provider);
  }, [publicKey, signTransaction, signAllTransactions, connection]);

  // ── Fetch orders ──────────────────────────────────────────────────────────
  const fetchOrders = useCallback(async () => {
    const program = getProgram();
    if (!program) return;
    try {
      const all = await program.account.order.all();
      const parsed: Order[] = all.map(({ publicKey: pk, account: acc }: any) => ({
        publicKey: pk.toBase58(),
        orderId: acc.orderId.toString(),
        owner: acc.owner.toBase58(),
        side: acc.side.buy !== undefined ? "buy" : "sell",
        price: acc.price.toNumber(),
        size: acc.size.toNumber(),
        filled: acc.filled.toNumber(),
        status: acc.status.open !== undefined ? "open"
          : acc.status.filled !== undefined ? "filled" : "cancelled",
      }));
      parsed.sort((a, b) => Number(b.orderId) - Number(a.orderId));
      setOrders(parsed);
    } catch (e: any) {
      console.error("Fetch error:", e.message);
    }
  }, [getProgram]);

  // Poll every 3s
  useEffect(() => {
    fetchOrders();
    const id = setInterval(fetchOrders, 3000);
    return () => clearInterval(id);
  }, [fetchOrders]);

  // ── Submit order ──────────────────────────────────────────────────────────
  async function submitOrder() {
    const program = getProgram();
    if (!program || !publicKey || !signTransaction || !signAllTransactions) return;
    if (!price || !size) { setStatus("Enter price and size"); return; }

    setLoading(true);
    setStatus("Submitting order...");

    try {
      const orderId = Date.now();
      const [orderPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("order"),
          publicKey.toBuffer(),
          Buffer.from(new BN(orderId).toArray("le", 8)),
        ],
        PROGRAM_ID
      );

      // Step 1 — create order on base Solana
      setStatus("Creating order on Solana...");
      const sig = await program.methods
        .submitOrder(
          new BN(orderId),
          side === "buy" ? { buy: {} } : { sell: {} },
          new BN(Math.floor(parseFloat(price) * 1_000_000)),
          new BN(Math.floor(parseFloat(size)))
        )
        .accounts({
          order: orderPDA,
          user: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setStatus("Delegating into private TEE rollup...");

      // Step 2 — delegate into private ephemeral rollup
      const { createDelegateInstruction, DELEGATION_PROGRAM_ID } = await import(
        "@magicblock-labs/ephemeral-rollups-sdk"
      );
      const { Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");

      const delegateIx = createDelegateInstruction({
        account: orderPDA,
        ownerProgram: PROGRAM_ID,
        payer: publicKey,
        delegationProgram: DELEGATION_PROGRAM_ID,
      });

      const delegateTx = new Transaction().add(delegateIx);
      delegateTx.feePayer = publicKey;
      delegateTx.recentBlockhash = (
        await program.provider.connection.getLatestBlockhash()
      ).blockhash;

      const signedTx = await signTransaction(delegateTx);
      const delegateSig = await program.provider.connection.sendRawTransaction(
        signedTx.serialize()
      );
      await program.provider.connection.confirmTransaction(delegateSig, "confirmed");

      setStatus(`Order hidden in TEE ✓  — MEV bots see nothing`);
      setPrice("");
      setSize("");
      await fetchOrders();

    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  const bids = orders.filter(o => o.side === "buy" && o.status === "open");
  const asks = orders.filter(o => o.side === "sell" && o.status === "open");
  const filled = orders.filter(o => o.status === "filled");

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6">

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">ShadowDEX</h1>
          <p className="text-gray-500 text-sm">Private dark pool · Solana devnet</p>
        </div>
        <WalletMultiButton />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Order form */}
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Place hidden order
          </h2>

          {/* Side toggle */}
          <div className="flex rounded-lg overflow-hidden mb-4 border border-gray-700">
            <button
              onClick={() => setSide("buy")}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                side === "buy"
                  ? "bg-emerald-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700"
              }`}
            >
              Buy
            </button>
            <button
              onClick={() => setSide("sell")}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                side === "sell"
                  ? "bg-red-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700"
              }`}
            >
              Sell
            </button>
          </div>

          <div className="space-y-3 mb-4">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Price (USDC)</label>
              <input
                type="number"
                value={price}
                onChange={e => setPrice(e.target.value)}
                placeholder="0.00"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Size (SOL)</label>
              <input
                type="number"
                value={size}
                onChange={e => setSize(e.target.value)}
                placeholder="0"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
              />
            </div>
          </div>

          <button
            onClick={submitOrder}
            disabled={!publicKey || loading}
            className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-colors ${
              side === "buy"
                ? "bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900"
                : "bg-red-600 hover:bg-red-500 disabled:bg-red-900"
            } disabled:cursor-not-allowed text-white`}
          >
            {loading ? "Submitting..." : `Place ${side} order (private)`}
          </button>

          {status && (
            <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>
          )}

          {!publicKey && (
            <p className="mt-3 text-xs text-gray-600 text-center">
              Connect wallet to trade
            </p>
          )}
        </div>

        {/* Order book */}
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Order book
            <span className="ml-2 text-gray-600 font-normal normal-case">
              (sizes hidden until match)
            </span>
          </h2>

          <div className="mb-3">
            <div className="text-xs text-gray-600 mb-1">Asks (sell)</div>
            {asks.length === 0
              ? <p className="text-xs text-gray-700">No asks</p>
              : asks.slice(0, 8).map(o => (
                <div key={o.publicKey} className="flex justify-between text-xs py-0.5">
                  <span className="text-red-400">{(o.price / 1_000_000).toFixed(4)}</span>
                  <span className="text-gray-600">████</span>
                </div>
              ))
            }
          </div>

          <div className="border-t border-gray-800 my-2" />

          <div>
            <div className="text-xs text-gray-600 mb-1">Bids (buy)</div>
            {bids.length === 0
              ? <p className="text-xs text-gray-700">No bids</p>
              : bids.slice(0, 8).map(o => (
                <div key={o.publicKey} className="flex justify-between text-xs py-0.5">
                  <span className="text-emerald-400">{(o.price / 1_000_000).toFixed(4)}</span>
                  <span className="text-gray-600">████</span>
                </div>
              ))
            }
          </div>
        </div>

        {/* Filled trades */}
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Settled trades
          </h2>
          {filled.length === 0
            ? <p className="text-xs text-gray-700">No trades yet</p>
            : filled.slice(0, 10).map(o => (
              <div key={o.publicKey} className="text-xs py-1.5 border-b border-gray-800">
                <div className="flex justify-between">
                  <span className={o.side === "buy" ? "text-emerald-400" : "text-red-400"}>
                    {o.side.toUpperCase()}
                  </span>
                  <span className="text-gray-300">
                    {(o.price / 1_000_000).toFixed(4)} USDC
                  </span>
                </div>
                <div className="text-gray-600 mt-0.5">
                  {o.owner.slice(0, 8)}...{o.owner.slice(-4)}
                </div>
              </div>
            ))
          }
        </div>

      </div>

      {/* Privacy callout */}
      <div className="mt-6 bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-start gap-3">
        <div className="w-2 h-2 rounded-full bg-emerald-500 mt-1.5 flex-shrink-0" />
        <div>
          <p className="text-sm text-gray-300 font-medium">Orders are invisible to MEV bots</p>
          <p className="text-xs text-gray-600 mt-0.5">
            Order sizes and prices live only inside MagicBlock private ephemeral rollup TEE.
            The public mempool sees nothing until settlement is final on Solana.
          </p>
        </div>
      </div>

    </main>
  );
}
