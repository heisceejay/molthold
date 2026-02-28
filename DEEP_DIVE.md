# Deep Dive: Agentic Solana Wallet v1

## 1. Wallet Design
The **Wallet design** of the `Agentic Solana Wallet` is intentionally built around a robust paradigm: the absolute isolation of key material. When autonomous AI agents sign transactions, the underlying cryptographic key material remains entirely shielded from the reasoning logic.

The architecture fundamentally relies on an injected `WalletClient` interface. Instead of exposing the raw ED25519 `Keypair` class directly to execution algorithms, the `Keypair` is initialized once inside a factory closure (`createWalletClient`) in `src/wallet/wallet.ts`. The methods that the interface surfaces natively sign the data provided without ever leaking the bytes into the garbage collector. Additionally, this module enforces robust memory management by immediately invoking `zeroBuffer(buf)` on the unencrypted buffers read into memory from the AES-256-GCM encrypted keystores, meaning the key bits only ever reside within the sealed V8 JavaScript heap of the `Keypair` class instance. This eliminates entire classes of secret leak vulnerabilities natively.

### Keystore Format and KDF Choice
Molthold manages the creation of AES-256-GCM ciphered JSON keystores. The files use a heavily parametrized `scrypt` Key Derivation Function (KDF) parameter constraint defined to be $N=32768, r=8, p=1$, tuned for high difficulty (~200ms duration per derivation) to combat brute-force offline dictionary attacks on exfiltrated files. A unique random Salt and 16-byte Initialization Vector (IV) is freshly provisioned per payload, strictly prohibiting IV-reuse vulnerabilities. Lastly, the GCM standard natively supplies an Auth Tag for validation, ensuring that if a malicious entity flips a single byte of the encrypted payload in the file without knowing the password, the CLI immediately throws a fatal exception rather than parsing malformed buffers.

## 2. Security Model
The system enforces defense-in-depth through three distinct, stacked layers:

1. **Key Isolation**: Covered above in Section 1. The key simply does not exist structurally beyond the `Keypair` instance. Serialization attempts on the closure (e.g. `JSON.stringify(wallet)`) are deliberately neutered or overridden to emit the `publicKey` only.
2. **Spending Limits Guard (`src/wallet/limits.ts`)**: Every time `.signAndSendTransaction` is invoked internally by the wallet client, it acts as a gating mechanism that routes the intention payload through the Spending Limit Guard before touching the RPC node or the keypair class. Limits enforce strictly sized `maxPerTxLamports` per individual signature requested, and a sliding-window `maxSessionLamports` value preventing unbounded bleeding of a fully compromised agent environment framework.
3. **Audit Trail (`logger.ts` & `audit.ts`)**: Transactions, rationale, and failures are recorded simultaneously to Pino (JSON to Stdout) and a local SQLite `.db` file cleanly separating structured data. The structured Pino Logger explicitly drops any properties with names tangentially indicative of private keys (`secret_key`, `seed`, etc.) through redaction filters if a developer were to erroneously console log the raw `Keypair`. Finally, rigorous test suites (`leak-audit.test.ts`) recursively assert that no length of characters matching regex patterns indicative of Base58 strings or `Uint8Array` byte chunks enters the datastores.

While these structures entirely protect against API compromises, file exfiltration, agent instruction hijacking, and excessive drain attacks, **it does not protect against physical host takeover**. If a malicious actor possesses the user's `$WALLET_PASSWORD` environment variable and host machine access, decryption is trivial via the CLI helper `npx tsx src/cli/index.ts`. 

## 3. AI Agent Interaction Model
The underlying AI agents interact with the `Molthold` system strictly via the `Strategy` interface (`src/agent/types.ts`). By formalizing the interactions, the agent ecosystem is completely decoupled from the Blockchain specifics. The agent only expects three primitive properties to construct its loop:
1. `name`: Its semantic identifier.
2. `decide(state)`: An async function that receives the pruned Blockchain State (Agent balances) from the Manager and returns an explicit intention (`Action`).
3. `execute(action, ...)`: An async function that fulfills the action generated in Step 2.

This agnostic interface implies that while `dca`, `rebalancer`, and `market_maker` happen to be rigid typescript-encoded algorithms locally executing token swaps and liquidity provisions on Jupiter and Orca, a developer reading the `SKILLS.md` manifest can instantiate an LLM API inside `decide` that makes decisions using ChatGPT/Anthropic instead of rules. Molthold allows agent abstraction models to run unhindered via the Manager `run` loop without interfering.

## 4. Devnet/LocalNet Demo Walkthrough
With `molthold`, standing up autonomous agent operations is a multi-step orchestration heavily reliant on the CLI interface natively provided.

First, standard JSON AES-GCM keystores are generated via straightforward prompts:
```bash
npx tsx src/cli/index.ts wallet create --name <id>
agentw wallet create --name test-agent-2
```

The system requires SOL strictly bound to these newly provisioned public keys.
```bash
npx tsx src/cli/index.ts wallet airdrop --name <id>
// Proceeds to fund 1 Localnet/Devnet SOL into the AES-256 target.
```

With the environment provisioned, you define the constraints internally inside `agents.json`:
```json
[
  {
    "id": "agent-1",
    "keystorePath": "keystores/agent-1.keystore.json",
    "strategy": "dca",
    "strategyParams": {
      "targetMint": "89umwgTLvF4kPAUH5dWubTzHyFRf6ewEe7gUKbPemj1K",
      // Swap sizes and destinations
    }
  }
]
```

Executing `npx tsx src/cli/index.ts agent start --config agents.json` spins up an internal multi-threading threadpool mimicking V8 process concurrency and manages SQLite handlers gracefully up until the process intercepts a `SIGINT` (Ctrl+C). Developers can view output simultaneously using the decoupled `log` checker:
```bash
npx tsx src/cli/index.ts agent log --name agent-1 --last 5
// Prints the last 5 SQLite execution records showing the generated transaction confirmation hashes.
```

---

## 5. Core Strategies
The Molthold ecosystem ships with four reference strategy implementations, each demonstrating a unique aspect of autonomous DeFi interaction.

### DCA (Dollar Cost Averaging)
Designed for long-term token accumulation, the **DCA** strategy periodically swaps a fixed SOL amount into a target mint. 
- **Goal:** Reduce the impact of volatility by spreading entry points over time.
- **Decision Logic:** On every tick, the strategy checks if the current SOL balance covers the `amountPerTickLamports` while maintaining a `minSolReserve`. 
- **Adapters:** Native integration with the `AdapterRegistry` allows the agent to dynamically route through whichever protocol (Jupiter or Orca) currently offers the best price.

### Rebalancer
The **Rebalancer** strategy maintains a static portfolio allocation (e.g., 60% SOL / 40% USDC).
- **Goal:** Harvest volatility by selling high and buying low automatically.
- **Decision Logic:** It fetches live USD prices via the Jupiter Price API and calculates the portfolio's total value. If the SOL weight drifts outside a configurable `bandPct` (e.g., ±5%), it generates a rebalancing swap.
- **Parameters:** Configurable `targetSolPct`, `bandPct`, and `slippageBps`.

### Monitor
The **Monitor** is a zero-risk, observability-only strategy that never executes transactions.
- **Goal:** Safe infrastructure testing and real-time dashboard data streaming.
- **Decision Logic:** It gathers balances and price data for a custom list of `trackedMints` and emits the telemetry as a `noop` action. 
- **Use Case:** Perfect for validating environment configurations and API connections without executing on-chain trades.

### Market Maker
The **Market Maker** strategy showcases advanced interaction with Concentrated Liquidity Market Makers (CLMMs).
- **Goal:** Earn fees by providing liquidity to Orca Whirlpool pools.
- **Decision Logic:** Evaluates if the agent's current token and SOL balances match the vault requirements for a specific liquidity range. If balances are sufficient, it triggers a `provide_liquidity` intent.
- **Execution:** Directly utilizes the `@orca-so/whirlpools-sdk` for precise position management.
