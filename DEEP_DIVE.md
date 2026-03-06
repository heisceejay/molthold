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
The underlying AI agents interact with the `Molthold` system strictly via the `Strategy` interface (`src/agent/types.ts`). In the current version, this has been simplified into a single **Universal Strategy** powered by an LLM reasoning core (**Claude 3 Haiku** via OpenRouter).

The agent loop works in three primitive phases:
1. **Gather**: The system snapshots the on-chain state (SOL/token balances).
2. **Decide**: The state is serialized and sent to the LLM. The LLM evaluates the state against its internal models for DCA, Rebalancing, or Liquidity Provision and returns an explicit intention (`Action`).
3. **Execute**: The `UniversalStrategy` fulfills the action, routing through the appropriate protocol adapters (Jupiter for swaps, Orca for liquidity).

This architecture allows the agent to be truly autonomous — it doesn't just follow a fixed script; it reacts to market conditions and portfolio state with high-level reasoning.

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
    "intervalMs": 5000,
    "limits": {
      "maxPerTxSol": 0.5,
      "maxSessionSol": 2.0
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

## 5. Universal Reasoning Capabilities
Instead of fixed strategies, the Molthold agent employs a comprehensive reasoning framework that allows it to perform multiple DeFi tasks dynamically.

### Dynamic DCA & Accumulation
The agent can decide to accumulate specific high-conviction assets when SOL reserves are high. Unlike a fixed DCA, it can adjust its "buy" size based on the perceived market state presented in the state snapshot.

### Intelligent Rebalancing
The agent monitors the ratio between SOL and its token holdings. If a token's value grows too large or small relative to SOL, the LLM will generate a `swap` action to restore a healthy portfolio balance, acting much like a traditional rebalancer but with the context of a wider mission.

### Liquidity Provision & Yield Generation
By utilizing the `provide_liquidity` action, the agent acts as a Market Maker on Orca Whirlpools. It evaluates its inventory and the target pool's state to decide when to inject liquidity, earning transaction fees for the wallet.

### Passive Observation (Monitoring)
If the market is volatile or the wallet's spending limits are reached, the LLM will return a `noop` action with a detailed rationale, essentially entering a "monitoring" mode until the next tick.
