---
system: agentic-solana-wallet
version: 1.1.0
network: solana-devnet
last_updated: 2026-03-06
schema_version: 1
---

# SKILLS.md — Agentic Solana Wallet Capability Manifest

This file is designed to be read by AI agents and agent frameworks.
It describes the wallet's capabilities, inputs, outputs, and constraints
in a structured format optimised for LLM context consumption.

---

## LLM Integration
The wallet uses external LLM APIs for autonomous decision making.
- **Providers:** Groq (primary), OpenRouter (fallback).
- **Logic:** If `GROQ_API_KEY` is set, it uses Groq's `llama-3.3-70b-versatile` for ultra-low latency. Otherwise, it falls back to OpenRouter using `anthropic/claude-3-haiku`.

---

## Identity

- **System:** agentic-solana-wallet
- **Version:** 1.1.0
- **Network:** Solana Devnet (mainnet blocked at runtime)
- **Language:** TypeScript (Node.js 20)
- **Entry point:** `src/cli/index.ts` (CLI) or import `src/wallet/index.ts` (library)

---

## Capabilities

### create_wallet
Creates a new ed25519 keypair and writes an AES-256-GCM encrypted keystore to disk.
- **Input:** `{ name: string, password: string, outputDir?: string }`
- **Output:** `{ publicKey: string, keystorePath: string }`
- **CLI:** `agentw wallet create --name <id>`

### get_sol_balance
Returns the SOL balance of a wallet.
- **Input:** `{ walletPubkey: string }` (implicit from WalletClient)
- **Output:** `{ lamports: bigint, sol: number }`
- **CLI:** `agentw wallet balance --name <id>`

### send_sol
Transfers SOL to a recipient address.
- **Input:** `{ to: string, lamports: bigint }`
- **Output:** `TxResult { signature, status, slot, error? }`
- **CLI:** `agentw wallet transfer --name <id> --to <pubkey> --amount <lamports>`

### swap_tokens
Swaps one token for another via Jupiter v6 or Orca Whirlpools.
- **Input:** `{ inputMint: string, outputMint: string, amountIn: bigint, slippageBps: number, adapter?: 'jupiter' | 'orca' | 'best' }`
- **Output:** `SwapResult { signature, outAmount, status, priceImpactPct }`

### start_agent
Starts an autonomous agent loop powered by LLM reasoning.
- **Input:** `{ agentId: string, intervalMs: number, configs: AgentConfig[] }`
- **Output:** Running AgentLoop (emits events to audit log)
- **CLI:** `agentw agent start --config agents.json` or `agentw agent start --name <id>`

### get_agent_status
Returns current agent state including health, balances, and session spending.
- **Input:** `{ agentId: string }`
- **Output:** `AgentLoopState { status, solBalance, sessionSpend, sessionCap, tickCount, lastActionAt }`
- **CLI:** `agentw agent status --name <id>`

---

## Reasoning Behaviors

The Molthold agent employs a unified Reasoning Core that dynamically determines the best course of action each tick.

### Accumulation (DCA)
The agent autonomously identifies opportunities to acquire tokens when SOL liquidity is sufficient.

### Rebalancing
The agent maintains a balanced portfolio by monitoring asset ratios and adjusting positions.

### Yield Generation
The agent provides liquidity to DEX pools (e.g. Orca Whirlpools) to earn fee revenue.

### Passive Monitoring
The agent observes the chain and logs telemetry without acting if risks are high or limits are reached.

---

## Constraints

- **Network:** `devnet` only.
- **Spending Limits:** Strictly enforced via `maxPerTxLamports` and `maxSessionLamports`.
- **Private Keys:** Never exposed in logs, API outputs, or database records.
- **Decision Engine:** LLM-driven via Groq/OpenRouter.
