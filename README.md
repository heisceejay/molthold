# Agentic Solana Wallet

An autonomous, programmable wallet for AI agents operating on Solana devnet. Agents can create wallets, sign transactions, hold SOL and SPL tokens, and interact with DeFi protocols — all without human intervention.

[![CI](https://github.com/molthold/agentic-wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/molthold/agentic-wallet/actions/workflows/ci.yml)

---

## Prerequisites

- **Node.js 20+** (`node --version` should show v20 or higher)
- **Git**
- A funded Solana devnet keypair (for integration tests; optional for unit tests)

---

## Quick Start (< 15 minutes)

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum, the defaults work for devnet or local testnet
# Be sure to set a secure WALLET_PASSWORD for the keystore.
```

### 2. Create your first agent wallet

```bash
npx tsx src/cli/index.ts wallet create --name agent-1
# Output: ✓ Created wallet for agent-1
```

### 3. Fund with Dev/Test SOL

```bash
npx tsx src/cli/index.ts wallet airdrop --name agent-1 --amount 1
# Output: ✓ Airdrop confirmed!
```
> **Note:** If you receive a `429 Too Many Requests` error, the Solana Devnet CLI faucet is globally rate-limited. To bypass this, run `npx tsx src/cli/index.ts wallet info --name agent-1` to get your public key, then paste it into a web faucet like [faucet.solana.com](https://faucet.solana.com/) to receive funds instantly.

### 4. Check balance

```bash
npx tsx src/cli/index.ts wallet balance --name agent-1
# Output: SOL balance: 1.000000 SOL (1,000,000,000 lamports)
```

### 5. Live Realtime Dashboard

The dashboard operates strictly as a read-only observability server. It hooks into the local SQLite Audit DB and streams real-time telemetry from your agents. Note that you must start the agents separately for them to appear running.

```bash
npx tsx src/cli/index.ts dashboard --config agents.json --port 3000
# Boots up a local UI dashboard polling logs.
# Navigate to http://localhost:3000 to view it.
```

### 6. Start a single agent

```bash
# Start a Market Maker agent
npx tsx src/cli/index.ts agent start --name agent-1 --strategy market_maker
# Available strategies: dca, rebalancer, monitor, market_maker
```

> [!NOTE]
> **Agents failing with "QUOTE_FAILED"**
> This is totally expected on Devnet. Public Devnet liquidity pools (AMM curves) on Jupiter and Orca are frequently empty. If an agent tries to swap and there is no liquidity, Jupiter throws `QUOTE_FAILED`. The agent catches this, logs it to the Audit DB safely, and waits for the next tick to try again. Only strategy guaranteed to work is `market_maker` agent to autonomously inject liquidity into the empty pools yourself!

### 7. Start the multi-agent execution pool

Launch the orchestration layer defined in your `agents.json`.
```bash
npx tsx src/cli/index.ts agent start --config agents.json
```

### 8. Manage individual agents (Cross-Process)

You can signal specific agents to stop gracefully without killing the entire pool or closing the terminal.
```bash
npx tsx src/cli/index.ts agent stop --name agent-1
```
The agent will detect the signal at the start of its next tick and shut down safely.

### 9. Inspect the Audit Database

```bash
npx tsx src/cli/index.ts agent log --name agent-1 --last 20
```
Safely prints the structured internal agent operations.

---

## Running Tests

```bash
# Unit tests (no network required)
npm run test:unit

# All tests with coverage report
npm run test:coverage

# Integration tests (requires WALLET_SECRET_KEY in .env)
npm run test:integration
```

---

## Configuration Reference

All configuration is via environment variables. Copy `.env.example` to `.env`.

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | RPC endpoint. Use a dedicated provider for reliability. |
| `SOLANA_NETWORK` | `devnet` | Network guard. Only `devnet` and `testnet` accepted. |
| `WALLET_PASSWORD` | — | Password for keystore decryption. Min 8 chars. |
| `WALLET_SECRET_KEY` | — | **Dev/CI only.** Base58 secret key. Disabled in production. |
| `MAX_PER_TX_SOL` | `0.1` | Per-transaction spending limit in SOL. |
| `MAX_SESSION_SOL` | `1.0` | Per-session cumulative spending cap in SOL. |
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` |
| `AUDIT_DB_PATH` | `./logs/audit.db` | SQLite audit log path. |
| `AGENT_INTERVAL_MS` | `30000` | Agent tick interval in milliseconds. |
| `NODE_ENV` | `development` | Set to `production` to enable mainnet block + disable secret key env var. |

---

## Architecture

```
CLI / Observer
     │
 Agent Layer          ← Strategy logic, decision loop, multi-agent manager
     │
Wallet Module ──── Protocol Adapters  ← Jupiter, Orca
     │                    │
          Solana RPC / Devnet
```

The wallet module is the security boundary. The `Keypair` is held in a factory closure and never exposed through the public interface. Protocol adapters receive only a `signTransaction` callback. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

---

## Security Model

**Key isolation:** Private keys are encrypted at rest using AES-256-GCM with a scrypt-derived key. In memory, the keypair is captured in a closure — it is never assigned to an object property, never logged, and never passed outside the wallet module. `JSON.stringify(wallet)` returns only the public key.

**Spending limits:** The `SpendingLimitGuard` runs synchronously before every signing operation. It enforces a per-transaction cap, a per-session cumulative cap, and an optional destination allowlist. Limit breaches throw immediately, before any RPC call is made.

**Audit trail:** Every transaction attempt and agent action is written to a SQLite append-only audit database. The database schema is designed so key material cannot appear in any row — enforced by a unit test.

---

## Troubleshooting

**`EAI_AGAIN` or DNS errors during `npm install`**
Your environment has outbound network blocked. Run `npm install` on a machine with internet access.

**Airdrop fails with "429 Too Many Requests"**
Devnet faucet is rate-limited. Wait 30 seconds and retry, or fund from a pre-funded funder wallet using `scripts/fund-agents.ts`.

**`WALLET_PASSWORD` not set error at startup**
Either set `WALLET_PASSWORD` in `.env` or pass `--password <pass>` to the CLI command.

**`Keystore file not found` error**
Run `npx tsx src/cli/index.ts wallet create --name <agent-name>` first to generate the keystore.

**Integration tests skipped**
Set `WALLET_SECRET_KEY` in `.env` to a funded devnet keypair. Generate one with `solana-keygen new` (Solana CLI) or use `npx tsx src/cli/index.ts wallet create`.

---

## Contributing

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module design and ADRs.
See [SKILLS.md](./SKILLS.md) for the agent-readable capability manifest.

```bash
npm run lint       # ESLint
npm run typecheck  # TypeScript strict check
npm run format     # Prettier
```

All PRs require passing CI (lint + typecheck + unit tests).
