# ShadowDEX

**Private dark pool trading on Solana — powered by MagicBlock Private Ephemeral Rollups**

---

## The Problem

Every trade on a public Solana DEX is visible before it executes.

When you submit an order, bots scan the mempool, detect your intent, and jump in front of you — buying before you buy, selling before you sell. This is MEV (Maximal Extractable Value), and it costs Solana traders hundreds of millions of dollars every year. It's not a bug — it's a structural consequence of a fully transparent public ledger.

Institutions won't trade on-chain under these conditions. Retail traders get silently drained on every swap. The problem isn't liquidity — it's visibility.

---

## The Solution

ShadowDEX is a private dark pool on Solana. Orders are submitted into a **Private Ephemeral Rollup** running inside a **Trusted Execution Environment (TEE)**. No one — not bots, not validators, not other traders — can see order sizes, prices, or counterparties until a trade is fully settled on-chain.

The public mempool sees nothing. Only the final matched transaction lands on Solana L1, with a cryptographic attestation proving fair execution.

---

## How It Uses MagicBlock Private Ephemeral Rollups

ShadowDEX uses three MagicBlock primitives directly:

### 1. TEE Authentication
Every matching engine session authenticates with the Private Ephemeral Rollup via a signed JWT token. The engine signs a challenge with its keypair and receives a session token valid for 30 days.
```typescript
// Get auth token from TEE endpoint
const signMessage = async (msg: Uint8Array) =>
  nacl.sign.detached(msg, wallet.secretKey);

const { token } = await getAuthToken(
  "https://tee.magicblock.app",
  wallet.publicKey,
  signMessage
);
```

### 2. Private Order Execution
The matching engine connects to the TEE RPC with the auth token as a bearer header. All order matching and settlement transactions are executed inside the TEE — invisible to the public mempool.
```typescript
// Connect to TEE with auth token
const teeConnection = new Connection("https://tee.magicblock.app", {
  commitment: "confirmed",
  httpHeaders: { Authorization: `Bearer ${token}` },
});

// Settle match inside TEE — not visible on public Solana
const sig = await teeProgram.methods
  .settleMatch(
    new BN(buyOrderId),
    new BN(sellOrderId),
    new BN(fillPrice),
    new BN(fillSize)
  )
  .accounts({ buyOrder, sellOrder, matcher: wallet.publicKey })
  .rpc();
```

### 3. Commit Back to Solana L1
After a match is settled privately inside the TEE, the final state is committed back to base Solana with a proof of execution.
```typescript
// Commit settled state from TEE back to Solana L1
const ix = createCommitAndUndelegateInstruction({
  delegatedAccount:  orderAccount,
  ownerProgram:      PROGRAM_ID,
  payer:             wallet.publicKey,
  delegationProgram: DELEGATION_PROGRAM_ID,
});
await sendAndConfirmTransaction(teeConnection, new Transaction().add(ix), [wallet]);
```

---

## Architecture
```
User → Submit order (Solana devnet)
              ↓
     Delegate account into TEE rollup
              ↓
     MagicBlock Private Ephemeral Rollup (tee.magicblock.app)
     ┌─────────────────────────────────────────┐
     │  Hidden order book (encrypted in TEE)   │
     │  Price-time priority matching engine    │
     │  settle_match CPI — invisible outside   │
     └─────────────────────────────────────────┘
              ↓
     commitAndUndelegate → Solana L1
     Final tx + attestation proof on-chain
```

## Project Structure
```
shadow DEX/
├── 📁 programs/shadowdex/src/
│   └── lib.rs                    # Anchor smart contract (submit_order, cancel_order, settle_match)
├── 📁 app/src/
│   ├── shadowdex-client.ts        # Client SDK for order submission and TEE delegation
│   ├── matching-engine.ts         # Price-time priority matching engine with TEE auth
│   └── test-delegation.ts        # TEE delegation testing utilities
├── 📁 ui/
│   ├── app/
│   │   ├── page.tsx              # Main trading interface with dark theme
│   │   ├── layout.tsx            # Wallet provider setup
│   │   └── globals.css           # Dark theme + wallet adapter styling
│   ├── components/
│   │   └── WalletContextProvider.tsx  # Solana wallet adapter configuration
│   └── package.json               # Next.js 16 + Tailwind + wallet adapter deps
├── 📄 .env                        # RPC endpoints (Helius + MagicBlock TEE)
├── 📄 Anchor.toml                 # Solana program configuration
└── 📄 README.md                   # This file
```

---

## Tech Stack

- **Solana program** — Anchor 0.32, deployed on devnet
- **Private Ephemeral Rollup** — MagicBlock TEE endpoint
- **Matching engine** — TypeScript, price-time priority
- **Frontend** — Next.js 16, Tailwind, Phantom wallet
- **SDK** — `@magicblock-labs/ephemeral-rollups-sdk` 

---

## Program

- **Program ID:** `HczPXyfpBMCkeyR1Z2GptoxtbmWRRpUvsvjZ9iCyMwwq` 
- **Network:** Solana Devnet
- **Instructions:** `submit_order`, `cancel_order`, `settle_match` 

---

## Running Locally
```bash
# Install dependencies
npm install

# Start the matching engine
npx tsx app/src/matching-engine.ts

# Start the UI (separate terminal)
cd ui && npm run dev
```

Open `http://localhost:3000`, connect Phantom on devnet, and place orders.

---

## Team

Built for **Solana Blitz v2 Hackathon** — Privacy track
