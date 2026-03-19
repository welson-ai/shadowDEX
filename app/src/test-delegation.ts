import { 
  loadWallet, 
  baseConnection, 
  rollupConnection, 
  getBaseProvider,
  orderPDA,
  PROGRAM_ID
} from "./shadowdex-client";
import { Program, BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const IDL = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../shadowdex/target/idl/shadowdex.json"),
    "utf-8"
  )
);

async function main() {
  const wallet = loadWallet();
  console.log("Wallet:", wallet.publicKey.toBase58());

  const baseSlot   = await baseConnection.getSlot();
  const rollupSlot = await rollupConnection.getSlot();
  console.log(`Base slot: ${baseSlot}   Rollup slot: ${rollupSlot}`);

  // Step 1: Submit order to BASE devnet
  const provider = getBaseProvider(wallet);
  const program  = new Program(IDL as any, provider);
  
  const orderId = Date.now();
  const orderAccount = orderPDA(wallet.publicKey, orderId);
  console.log("Order PDA:", orderAccount.toBase58());

  const sig = await program.methods
    .submitOrder(
      new BN(orderId),
      { buy: {} },
      new BN(100_000),
      new BN(10)
    )
    .accounts({
      order:         orderAccount,
      user:          wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  console.log("Order submitted to devnet ✓  sig:", sig);
  console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

main().catch(console.error);
