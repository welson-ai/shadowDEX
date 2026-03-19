import { loadWallet, baseConnection, rollupConnection, submitOrder, delegateOrderToRollup, orderPDA, PROGRAM_ID } from "./shadowdex-client";

async function main() {
  const wallet = loadWallet();
  console.log("Wallet:", wallet.publicKey.toBase58());

  // Check both connections
  const baseSlot   = await baseConnection.getSlot();
  const rollupSlot = await rollupConnection.getSlot();
  console.log(`Base slot: ${baseSlot}   Rollup slot: ${rollupSlot}`);

  // Submit one test order directly to rollup
  const orderId = Date.now();
  const { orderAccount, sig } = await submitOrder(
    wallet,
    orderId,
    { buy: {} },
    100_000,   // price: 0.0001 SOL per unit
    10,        // size: 10 units
  );

  console.log("Order PDA:", orderAccount.toBase58());
  console.log("Done ✓");
}

main().catch(console.error);
