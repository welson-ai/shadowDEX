import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import {
  createDelegateInstruction,
  createCommitAndUndelegateInstruction,
  getAuthToken,
  ConnectionMagicRouter,
  DELEGATION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

// ── IDL ───────────────────────────────────────────────────────────────────────
const IDL = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../shadowdex/target/idl/shadowdex.json"),
    "utf-8"
  )
);

// ── Connections ───────────────────────────────────────────────────────────────
export const baseConnection   = new Connection(process.env.SOLANA_RPC!,   "confirmed");
export const rollupConnection = new Connection(process.env.TEE_RPC!,      "confirmed");

// ── Wallet ────────────────────────────────────────────────────────────────────
export function loadWallet(): Keypair {
  const raw = fs.readFileSync(
    process.env.ANCHOR_WALLET!.replace("~", process.env.HOME!),
    "utf-8"
  );
  return Keypair.fromSecretKey(Buffer.from(JSON.parse(raw)));
}

// ── Providers ─────────────────────────────────────────────────────────────────
function makeProvider(connection: Connection, wallet: Keypair): AnchorProvider {
  return new AnchorProvider(
    connection,
    {
      publicKey: wallet.publicKey,
      signTransaction:    async (tx) => { tx.sign(wallet); return tx; },
      signAllTransactions: async (txs) => { txs.forEach(t => t.sign(wallet)); return txs; },
    },
    { commitment: "confirmed" }
  );
}

export function getBaseProvider(wallet: Keypair)   { return makeProvider(baseConnection,   wallet); }
export function getRollupProvider(wallet: Keypair) { return makeProvider(rollupConnection, wallet); }

export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID!);

// ── PDA ───────────────────────────────────────────────────────────────────────
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

// ── Step 1: Submit order on base Solana ───────────────────────────────────────
export async function submitOrderBase(
  wallet: Keypair,
  orderId: number,
  side: "buy" | "sell",
  price: number,
  size: number
): Promise<PublicKey> {
  const provider = getBaseProvider(wallet);
  const program  = new Program(IDL as any, provider);
  const account  = orderPDA(wallet.publicKey, orderId);

  await program.methods
    .submitOrder(
      new BN(orderId),
      side === "buy" ? { buy: {} } : { sell: {} },
      new BN(price),
      new BN(size)
    )
    .accounts({
      order:         account,
      user:          wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  console.log(`[base] Order #${orderId} created — PDA: ${account.toBase58()}`);
  return account;
}

// ── Step 2: Delegate order account into TEE rollup ────────────────────────────
export async function delegateOrder(
  wallet: Keypair,
  orderAccount: PublicKey
): Promise<void> {
  console.log(`[delegate] Delegating ${orderAccount.toBase58()} into TEE rollup...`);

  const ix = createDelegateInstruction({
    account:            orderAccount,
    ownerProgram:       PROGRAM_ID,
    payer:              wallet.publicKey,
    delegationProgram:  DELEGATION_PROGRAM_ID,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(baseConnection, tx, [wallet]);
  console.log(`[delegate] Delegated ✓  sig: ${sig}`);
}

// ── Step 3: Get TEE auth token (proves execution inside TEE) ──────────────────
export async function getTeeAuthToken(wallet: Keypair): Promise<string> {
  console.log("[tee] Requesting auth token...");
  const token = await getAuthToken(rollupConnection, wallet);
  console.log("[tee] Auth token obtained ✓");
  return token;
}

// ── Step 4: Settle match inside the rollup ────────────────────────────────────
export async function settleMatchInRollup(
  matcher: Keypair,
  buyOrderAccount: PublicKey,
  sellOrderAccount: PublicKey,
  buyOrderId: number,
  sellOrderId: number,
  fillPrice: number,
  fillSize: number
): Promise<string> {
  const provider = getRollupProvider(matcher);
  const program  = new Program(IDL as any, provider);

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

  console.log(`[rollup] Match settled ✓  sig: ${sig}`);
  return sig;
}

// ── Step 5: Commit + undelegate back to base Solana ───────────────────────────
export async function commitAndUndelegate(
  wallet: Keypair,
  orderAccount: PublicKey
): Promise<void> {
  console.log(`[commit] Committing ${orderAccount.toBase58()} back to Solana...`);

  const ix = createCommitAndUndelegateInstruction({
    account:           orderAccount,
    ownerProgram:      PROGRAM_ID,
    payer:             wallet.publicKey,
    delegationProgram: DELEGATION_PROGRAM_ID,
  });

  const tx  = new Transaction().add(ix);
  // Commit is sent to the rollup, which then finalizes on base
  const sig = await sendAndConfirmTransaction(rollupConnection, tx, [wallet]);
  console.log(`[commit] Committed to base Solana ✓  sig: ${sig}`);
}
