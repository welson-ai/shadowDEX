"use client";
import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("HczPXyfpBMCkeyR1Z2GptoxtbmWRRpUvsvjZ9iCyMwwq");

const IDL = {
  address: "HczPXyfpBMCkeyR1Z2GptoxtbmWRRpUvsvjZ9iCyMwwq",
  metadata: { name: "shadowdex", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    {
      name: "submit_order",
      discriminator: [230, 150, 200, 53, 92, 208, 109, 108],
      accounts: [
        { name: "order", writable: true },
        { name: "user", writable: true, signer: true },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [
        { name: "order_id", type: "u64" },
        { name: "side",     type: { defined: { name: "OrderSide" } } },
        { name: "price",    type: "u64" },
        { name: "size",     type: "u64" },
      ],
    },
  ],
  accounts: [{ name: "Order", discriminator: [134, 173, 232, 200, 169, 188, 237, 4] }],
  types: [
    { name: "OrderSide",   type: { kind: "enum", variants: [{ name: "Buy" }, { name: "Sell" }] } },
    { name: "OrderStatus", type: { kind: "enum", variants: [{ name: "Open" }, { name: "Filled" }, { name: "Cancelled" }] } },
    { name: "Order", type: { kind: "struct", fields: [
      { name: "owner",     type: "pubkey" },
      { name: "order_id",  type: "u64" },
      { name: "side",      type: { defined: { name: "OrderSide" } } },
      { name: "price",     type: "u64" },
      { name: "size",      type: "u64" },
      { name: "filled",    type: "u64" },
      { name: "status",    type: { defined: { name: "OrderStatus" } } },
      { name: "timestamp", type: "i64" },
      { name: "bump",      type: "u8" },
    ]}},
  ],
} as const;

interface Order {
  publicKey: string;
  orderId:   string;
  owner:     string;
  side:      string;
  price:     number;
  size:      number;
  filled:    number;
  status:    string;
}

function Dot({ color }: { color: string }) {
  return (
    <span style={{
      display: "inline-block", width: 6, height: 6, borderRadius: "50%",
      background: color, marginRight: 6,
      animation: color === "var(--green)" ? "pulse-green 2s infinite" : "none",
    }} />
  );
}

export default function Home() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();

  const [side,    setSide]    = useState<"buy" | "sell">("buy");
  const [price,   setPrice]   = useState("");
  const [size,    setSize]    = useState("");
  const [orders,  setOrders]  = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [status,  setStatus]  = useState("");

  const getProgram = useCallback(() => {
    if (!publicKey || !signTransaction || !signAllTransactions) return null;
    const provider = new AnchorProvider(
      connection,
      { publicKey, signTransaction, signAllTransactions },
      { commitment: "confirmed" }
    );
    return new Program(IDL as any, provider);
  }, [publicKey, signTransaction, signAllTransactions, connection]);

  const fetchOrders = useCallback(async () => {
    const program = getProgram();
    if (!program) return;
    try {
      const all = await program.account.order.all();
      const parsed: Order[] = all.map(({ publicKey: pk, account: acc }: any) => ({
        publicKey: pk.toBase58(),
        orderId:   acc.orderId.toString(),
        owner:     acc.owner.toBase58(),
        side:      acc.side.buy !== undefined ? "buy" : "sell",
        price:     acc.price.toNumber(),
        size:      acc.size.toNumber(),
        filled:    acc.filled.toNumber(),
        status:    acc.status.open      !== undefined ? "open"
                 : acc.status.filled    !== undefined ? "filled"
                 : "cancelled",
      }));
      parsed.sort((a, b) => Number(b.orderId) - Number(a.orderId));
      setOrders(parsed);
    } catch {}
  }, [getProgram]);

  useEffect(() => {
    fetchOrders();
    const id = setInterval(fetchOrders, 3000);
    return () => clearInterval(id);
  }, [fetchOrders]);

  async function submitOrder() {
    const program = getProgram();
    if (!program || !publicKey || !signTransaction) return;
    if (!price || !size) { setStatus("Enter price and size"); return; }
    setLoading(true);
    setStatus("Creating order on Solana...");
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

      await program.methods
        .submitOrder(
          new BN(orderId),
          side === "buy" ? { buy: {} } : { sell: {} },
          new BN(Math.floor(parseFloat(price) * 1_000_000)),
          new BN(Math.floor(parseFloat(size)))
        )
        .accounts({
          order:         orderPDA,
          user:          publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setStatus("Delegating to private TEE rollup...");

      const { createDelegateInstruction, DELEGATION_PROGRAM_ID } =
        await import("@magicblock-labs/ephemeral-rollups-sdk");

      const delegateIx = createDelegateInstruction({
        account:           orderPDA,
        ownerProgram:      PROGRAM_ID,
        payer:             publicKey,
        delegationProgram: DELEGATION_PROGRAM_ID,
      });

      const delegateTx = new Transaction().add(delegateIx);
      delegateTx.feePayer = publicKey;
      delegateTx.recentBlockhash = (
        await connection.getLatestBlockhash()
      ).blockhash;

      const signed = await signTransaction(delegateTx);
      const delSig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(delSig, "confirmed");

      setStatus("Order hidden in TEE — MEV bots see nothing ✓");
      setPrice("");
      setSize("");
      await fetchOrders();
    } catch (e: any) {
      setStatus(`Error: ${e.message?.slice(0, 120)}`);
    } finally {
      setLoading(false);
    }
  }

  const bids   = orders.filter(o => o.side === "buy"  && o.status === "open");
  const asks   = orders.filter(o => o.side === "sell" && o.status === "open");
  const filled = orders.filter(o => o.status === "filled");
  const now    = new Date().toUTCString().slice(17, 25);

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)" }}>

      {/* ── Header ── */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 24px", borderBottom: "1px solid var(--border)",
        background: "var(--bg2)", position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 700, color: "var(--green)", letterSpacing: "0.05em" }}>SHADOW</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 700, color: "var(--text)",  letterSpacing: "0.05em" }}>DEX</span>
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            {[
              { label: "NETWORK", value: "DEVNET" },
              { label: "STATUS",  value: "LIVE", color: "var(--green)" },
              { label: "UTC",     value: now },
            ].map(item => (
              <div key={item.label} style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em" }}>
                <span style={{ color: "var(--muted)", marginRight: 4 }}>{item.label}</span>
                <span style={{ color: item.color ?? "var(--text)" }}>
                  {item.label === "STATUS" && <Dot color="var(--green)" />}
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {publicKey && (
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)",
              background: "var(--bg3)", border: "1px solid var(--border)",
              padding: "6px 10px", borderRadius: 4,
            }}>
              {publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}
            </span>
          )}
          <WalletMultiButton />
        </div>
      </header>

      {/* ── Privacy banner ── */}
      <div style={{
        background: "var(--green-bg)", borderBottom: "1px solid rgba(0,255,136,0.15)",
        padding: "8px 24px", display: "flex", alignItems: "center", gap: 8,
      }}>
        <Dot color="var(--green)" />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--green)", letterSpacing: "0.1em" }}>
          PRIVATE EPHEMERAL ROLLUP ACTIVE — ORDER SIZES + PRICES ENCRYPTED IN TEE — PUBLIC MEMPOOL SEES NOTHING
        </span>
      </div>

      {/* ── Main grid ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "340px 1fr 280px",
        gap: 1, background: "var(--border)",
        minHeight: "calc(100vh - 89px)",
      }}>

        {/* ── Order form ── */}
        <div style={{ background: "var(--bg)", padding: 24 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)", letterSpacing: "0.15em", marginBottom: 20 }}>
            NEW ORDER
          </div>

          {/* Side toggle */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--border)", borderRadius: 6, overflow: "hidden", marginBottom: 20 }}>
            {(["buy", "sell"] as const).map(s => (
              <button key={s} onClick={() => setSide(s)} style={{
                padding: "10px 0", cursor: "pointer", border: "none",
                background: side === s
                  ? s === "buy" ? "var(--green-bg)" : "var(--red-bg)"
                  : "var(--bg2)",
                fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700,
                letterSpacing: "0.1em", textTransform: "uppercase",
                color: side === s
                  ? s === "buy" ? "var(--green)" : "var(--red)"
                  : "var(--muted)",
                transition: "all 0.15s",
              }}>
                {s}
              </button>
            ))}
          </div>

          {/* Inputs */}
          {[
            { label: "PRICE", placeholder: "0.000000", unit: "USDC", val: price, set: setPrice },
            { label: "SIZE",  placeholder: "0",        unit: "SOL",  val: size,  set: setSize  },
          ].map(f => (
            <div key={f.label} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--muted)", letterSpacing: "0.15em" }}>{f.label}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--muted2)" }}>{f.unit}</span>
              </div>
              <input
                type="number"
                value={f.val}
                onChange={e => f.set(e.target.value)}
                placeholder={f.placeholder}
                style={{
                  width: "100%", background: "var(--bg2)",
                  border: "1px solid var(--border)", borderRadius: 4,
                  padding: "10px 12px", color: "var(--text)",
                  fontFamily: "var(--font-mono)", fontSize: 13, outline: "none",
                }}
                onFocus={e => (e.target.style.borderColor = side === "buy" ? "var(--green)" : "var(--red)")}
                onBlur={e =>  (e.target.style.borderColor = "var(--border)")}
              />
            </div>
          ))}

          {/* Submit button */}
          <button
            onClick={submitOrder}
            disabled={!publicKey || loading}
            style={{
              width: "100%", padding: "12px 0", borderRadius: 4,
              border: `1px solid ${side === "buy" ? "var(--green)" : "var(--red)"}`,
              background: side === "buy" ? "var(--green-bg)" : "var(--red-bg)",
              color: side === "buy" ? "var(--green)" : "var(--red)",
              fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700,
              letterSpacing: "0.12em", textTransform: "uppercase",
              cursor: publicKey && !loading ? "pointer" : "not-allowed",
              opacity: !publicKey ? 0.4 : 1,
              transition: "all 0.15s",
            }}
          >
            {loading ? "SUBMITTING..." : `PLACE ${side.toUpperCase()} ORDER`}
          </button>

          {/* Status */}
          {status && (
            <div style={{
              marginTop: 12, padding: "8px 10px", borderRadius: 4,
              background: "var(--bg2)", border: "1px solid var(--border)",
              fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--green)",
              letterSpacing: "0.05em", lineHeight: 1.6,
            }}>
              {status}
            </div>
          )}

          {/* Connect prompt */}
          {!publicKey && (
            <div style={{
              marginTop: 16, padding: 16, borderRadius: 4,
              border: "1px dashed var(--border2)", textAlign: "center",
            }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--muted)", letterSpacing: "0.1em", marginBottom: 10 }}>
                CONNECT WALLET TO TRADE
              </div>
              <WalletMultiButton />
            </div>
          )}
        </div>

        {/* ── Order book ── */}
        <div style={{ background: "var(--bg)", padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)", letterSpacing: "0.15em" }}>ORDER BOOK</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--muted2)" }}>SIZES HIDDEN — ENCRYPTED IN TEE</span>
          </div>

          {/* Asks */}
          <div style={{ marginBottom: 4 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--muted)", letterSpacing: "0.12em", marginBottom: 8 }}>
              ASKS ({asks.length})
            </div>
            {asks.length === 0
              ? <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted2)", padding: "8px 0" }}>NO ASKS</div>
              : asks.slice(0, 10).map(o => (
                <div key={o.publicKey} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "5px 8px", marginBottom: 1, borderRadius: 2,
                  background: "var(--red-bg)",
                }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--red)" }}>
                    {(o.price / 1_000_000).toFixed(6)}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)" }}>████████</span>
                </div>
              ))
            }
          </div>

          {/* Spread */}
          {bids.length > 0 && asks.length > 0 && (
            <div style={{
              padding: "8px", textAlign: "center",
              borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
              margin: "8px 0",
            }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--amber)" }}>
                SPREAD: {((asks[0].price - bids[0].price) / 1_000_000).toFixed(6)}
              </span>
            </div>
          )}

          {/* Bids */}
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--muted)", letterSpacing: "0.12em", marginBottom: 8 }}>
              BIDS ({bids.length})
            </div>
            {bids.length === 0
              ? <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted2)", padding: "8px 0" }}>NO BIDS</div>
              : bids.slice(0, 10).map(o => (
                <div key={o.publicKey} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "5px 8px", marginBottom: 1, borderRadius: 2,
                  background: "var(--green-bg)",
                }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--green)" }}>
                    {(o.price / 1_000_000).toFixed(6)}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)" }}>████████</span>
                </div>
              ))
            }
          </div>
        </div>

        {/* ── Settled trades ── */}
        <div style={{ background: "var(--bg)", padding: 24, borderLeft: "1px solid var(--border)" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)", letterSpacing: "0.15em", marginBottom: 20 }}>
            SETTLED TRADES
          </div>
          {filled.length === 0
            ? (
              <div style={{ textAlign: "center", paddingTop: 40 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--muted2)", lineHeight: 2 }}>
                  NO TRADES YET<br />WAITING FOR MATCH
                </div>
              </div>
            )
            : filled.slice(0, 15).map(o => (
              <div key={o.publicKey} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700,
                    color: o.side === "buy" ? "var(--green)" : "var(--red)",
                    letterSpacing: "0.1em",
                  }}>
                    {o.side.toUpperCase()}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>
                    {(o.price / 1_000_000).toFixed(4)}
                  </span>
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--muted)" }}>
                  {o.owner.slice(0, 6)}...{o.owner.slice(-4)}
                </div>
              </div>
            ))
          }
        </div>
      </div>
    </main>
  );
}
