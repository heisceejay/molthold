---
system: agentic-solana-wallet
version: 1.0.0
network: solana-devnet
last_updated: 2026-02-27
schema_version: 1
---

# SKILLS.md — Agentic Solana Wallet Capability Manifest

This file is designed to be read by AI agents and agent frameworks.
It describes the wallet's capabilities, inputs, outputs, and constraints
in a structured format optimised for LLM context consumption.

---

## Identity

- **System:** agentic-solana-wallet
- **Version:** 1.0.0
- **Network:** Solana Devnet (mainnet blocked at runtime)
- **Language:** TypeScript (Node.js 20)
- **Entry point:** `src/cli/index.ts` (CLI) or import `src/wallet/index.ts` (library)

---

## Capabilities

### create_wallet
Creates a new ed25519 keypair and writes an AES-256-GCM encrypted keystore to disk.
- **Input:** `{ name: string, password: string, outputDir?: string }`
- **Output:** `{ publicKey: string, keystorePath: string }`
- **Side effects:** Creates `keystores/<name>.json` with permissions 0600
- **CLI:** `npx tsx src/cli/index.ts wallet create --name <id>`

### load_wallet
Loads an existing wallet from a keystore file.
- **Input:** `{ keystorePath: string, password: string }`
- **Output:** `WalletClient` instance (in-process only — not serialisable)
- **Note:** Password can come from `WALLET_PASSWORD` env var

### get_sol_balance
Returns the SOL balance of a wallet.
- **Input:** `{ walletPubkey: string }` (implicit from WalletClient)
- **Output:** `{ lamports: bigint, sol: number }`
- **CLI:** `npx tsx src/cli/index.ts wallet balance --name <id>`

### get_token_balance
Returns the SPL token balance for a given mint.
- **Input:** `{ mint: string }` (base58 mint address)
- **Output:** `{ amount: bigint, decimals: number }`

### send_sol
Transfers SOL to a recipient address.
- **Input:** `{ to: string, lamports: bigint }`
- **Output:** `TxResult { signature, status, slot, error? }`
- **Limits:** Subject to SpendingLimitGuard (see Constraints)
- **CLI:** `npx tsx src/cli/index.ts wallet transfer --name <id> --to <pubkey> --amount <lamports>`

### send_token
Transfers an SPL token to a recipient. Creates destination ATA if needed.
- **Input:** `{ mint: string, to: string, amount: bigint }`
- **Output:** `TxResult { signature, status, slot, error? }`

### swap_tokens
Swaps one token for another via Jupiter v6 or Orca Whirlpools.
- **Input:** `{ inputMint: string, outputMint: string, amountIn: bigint, slippageBps: number, adapter?: 'jupiter' | 'orca' }`
- **Output:** `SwapResult { signature, outAmount, status, priceImpactPct }`
- **Default adapter:** `jupiter` (best price routing across pools)

### get_best_quote
Fetches the best swap quote without executing.
- **Input:** `{ inputMint: string, outputMint: string, amountIn: bigint }`
- **Output:** `{ quote: Quote, adapter: 'jupiter' | 'orca' }`

### start_agent
Starts an autonomous agent loop with a named strategy.
- **Input:** `{ agentId: string, strategy: 'dca' | 'rebalancer' | 'monitor', params: StrategyParams }`
- **Output:** Running AgentLoop (emits events to audit log)
- **CLI:** `npx tsx src/cli/index.ts agent start --name <id> --strategy <name>`

### get_agent_status
Returns current agent state including last action, tick count, and balances.
- **Input:** `{ agentId: string }`
- **Output:** `AgentLoopState { agentId, tickCount, lastActionAt, walletPubkey }`
- **CLI:** `npx tsx src/cli/index.ts agent status --name <id>`

---

## Strategies

### dca (Dollar-Cost Averaging)
Buys a fixed amount of a target token at each tick regardless of price.
- **Params:** `targetMint`, `amountPerTickLamports`, `adapter`, `minSolReserveLamports`
- **Decision:** If SOL balance > minSolReserve → swap. Else → noop.

### rebalancer
Maintains a target SOL/token portfolio ratio within a configurable band.
- **Params:** `targetMint`, `targetSolPct` (0–100), `bandPct`, `adapter`
- **Decision:** If current allocation is outside band → swap to rebalance. Else → noop.

### monitor
Read-only agent. Logs balances and prices each tick without transacting.
  - **Params:** `trackedMints` (array of mint addresses to track)
  - **Decision:** Always → noop (purely observational)
  
  ### market_maker (Liquidity Provider)
  Autonomously provides liquidity to an Orca Whirlpools AMM given sufficient balances.
  - **Params:** `targetMint`, `amountSolLamports`, `amountToken`
  - **Decision:** If SOL balance ≥ `amountSolLamports` → provide_liquidity. Else → noop.

---

## TxResult Schema

```typescript
{
  signature: string | null,  // base58 transaction signature
  status: 'confirmed' | 'failed' | 'timeout' | 'simulated',
  slot?: number,             // confirmation slot
  error?: string,            // human-readable error (never contains key material)
  computeUnitsConsumed?: number
}
```

---

## Constraints

- **Network:** `devnet` only. Mainnet URLs are blocked at runtime.
- **Max per-tx spend:** Configurable via `MAX_PER_TX_SOL` (default: 0.1 SOL)
- **Max session spend:** Configurable via `MAX_SESSION_SOL` (default: 1.0 SOL)
- **Private keys:** Never exposed via any API output, log, or serialisation
- **Key storage:** AES-256-GCM encrypted at rest, scrypt KDF (N=32768)
- **Signing:** Always occurs inside the WalletClient closure — protocol adapters receive only a callback

---

## Error Codes

| Code | Meaning | Retryable |
|---|---|---|
| `LIMIT_BREACH` | Transaction rejected by SpendingLimitGuard | No — adjust limits config |
| `SIMULATION_FAILED` | Transaction simulation rejected by RPC | Sometimes — check params |
| `INSUFFICIENT_FUNDS` | Wallet balance too low | No — fund the wallet |
| `RPC_ERROR` | Network or RPC node error | Yes — retry with backoff |
| `INVALID_KEYSTORE` | Keystore file missing, corrupted, or wrong password | No — fix keystore |
| `SIGNING_FAILED` | Cryptographic signing failed | No — internal error |
| `MAINNET_BLOCKED` | Attempt to connect to mainnet | No — use devnet |
| `INVALID_CONFIG` | Configuration parameter invalid | No — fix config |

---

## Audit Log Schema

Every action is written to SQLite at `AUDIT_DB_PATH`. Each row:

```
id, ts, agent_id, event, wallet_pk, signature, status, details_json
```

`event` values: `tx_attempt`, `tx_confirmed`, `tx_failed`, `agent_action`, `limit_breach`

`details_json` never contains key material (enforced by unit test).

---

## Integration Example (TypeScript)

```typescript
import { createWalletClient, loadKeystore } from './src/wallet/index.js';
import { createLogger } from './src/logger/index.js';

const logger = createLogger({ level: 'info' });
const keypair = loadKeystore('./keystores/agent-1.json', process.env.WALLET_PASSWORD!);
const wallet = createWalletClient(keypair, {
  rpcUrl: 'https://api.devnet.solana.com',
  limits: { maxPerTxLamports: 100_000_000n, maxSessionLamports: 1_000_000_000n },
  simulateBeforeSend: true,
  confirmationStrategy: 'confirmed',
  maxRetries: 3,
  retryDelayMs: 1000,
}, logger);

const balance = await wallet.getSolBalance();
console.log(`Balance: ${balance} lamports`);
```
