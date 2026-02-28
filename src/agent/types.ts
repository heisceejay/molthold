/**
 * @file src/agent/types.ts
 * Shared types for the agent layer.
 *
 * DESIGN: The agent layer knows about wallets and adapters only through
 * their interfaces. It never imports from wallet internals (keystore, signer,
 * limits) or protocol internals (jupiter, orca). This means the entire
 * agent layer can be tested with mock wallets and mock adapters.
 */

import type { WalletClient, TxResult, SpendingLimits } from '../wallet/types.js';
import type { AdapterRegistry } from '../protocols/types.js';

// ── Strategy names ────────────────────────────────────────────────────────────

export type StrategyName = 'dca' | 'rebalancer' | 'monitor' | 'market_maker';

// ── Agent configuration (loaded from agents.json) ─────────────────────────────

export interface AgentConfig {
  /** Unique identifier for this agent instance. Used in logs and audit DB. */
  id: string;
  /** Path to the encrypted keystore file for this agent's wallet. */
  keystorePath: string;
  /** Name of the strategy to run. */
  strategy: StrategyName;
  /** Strategy-specific parameters — validated by the strategy class at startup. */
  strategyParams: Record<string, unknown>;
  /** Tick interval in milliseconds. */
  intervalMs: number;
  /**
   * Spending limits for this agent's wallet.
   * Stored as SOL numbers in agents.json, converted to lamports at load time.
   */
  limits: SpendingLimits;
}

// ── Agent runtime state ───────────────────────────────────────────────────────

/**
 * A snapshot of an agent's current state, gathered at the start of each tick.
 * Passed to strategy.decide() — it is the only information a strategy sees.
 */
export interface AgentState {
  agentId: string;
  walletPubkey: string;
  solBalance: bigint;
  /** Token balances keyed by mint address (base58). */
  tokenBalances: Map<string, bigint>;
  /** Timestamp of the last non-noop action, or null if no action yet. */
  lastActionAt: Date | null;
  /** Total ticks completed since agent start. */
  tickCount: number;
  /** Unix ms timestamp when this state snapshot was taken. */
  snapshotAt: number;
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * An Action is the output of strategy.decide().
 * It represents a typed intent — the strategy.execute() method translates
 * the intent into wallet/adapter calls.
 *
 * `noop` means the strategy decided to do nothing this tick.
 */
export interface Action {
  type: 'swap' | 'transfer' | 'provide_liquidity' | 'noop';
  params: Record<string, unknown>;
  /** Human-readable explanation written to the audit log. */
  rationale: string;
}

export interface SwapActionParams {
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  slippageBps: number;
  adapter: 'jupiter' | 'orca';
}

export interface TransferActionParams {
  to: string;
  lamports: bigint;
}

export interface ProvideLiquidityActionParams {
  targetMint: string;
  amountSolLamports: bigint;
  amountToken: bigint;
}

// ── Strategy interface ────────────────────────────────────────────────────────

/**
 * Every strategy must implement this interface.
 *
 * DESIGN: decide() is a pure async function of AgentState — no side effects.
 *         execute() is the side-effectful part — it calls wallet and adapter methods.
 *         Keeping these separate makes decide() trivially unit-testable.
 */
export interface Strategy {
  readonly name: StrategyName;

  /**
   * Decides what to do this tick given the current on-chain state.
   * Must not have side effects. Must not call wallet or adapter methods.
   * @returns An Action (including noop if nothing to do).
   */
  decide(state: AgentState): Promise<Action>;

  /**
   * Executes the action returned by decide().
   * @returns A TxResult if a transaction was submitted, null for noop.
   */
  execute(
    action: Action,
    wallet: WalletClient,
    adapters: AdapterRegistry,
  ): Promise<TxResult | null>;
}

// ── Agent loop state (for observability) ─────────────────────────────────────

export type AgentLoopStatus = 'idle' | 'running' | 'stopped' | 'error';

export interface AgentLoopState {
  agentId: string;
  status: AgentLoopStatus;
  walletPubkey: string;
  strategy: StrategyName;
  tickCount: number;
  lastTickAt: Date | null;
  lastActionAt: Date | null;
  lastError: string | null;
  startedAt: Date | null;
}
