/**
 * @file src/agent/loop.ts
 *
 * AgentLoop — the runtime engine for a single agent instance.
 *
 * CRASH ISOLATION: Every tick is wrapped in a top-level try/catch.
 * A throwing strategy, a failed RPC call, or a limit breach are all caught,
 * logged, and written to the audit DB. The loop always continues.
 *
 * ATOMICITY: From the loop's perspective, each tick is atomic. The wallet
 * state before and after a tick is consistent — we never hold partial state
 * across tick boundaries.
 *
 * STOPPING: stop() sets a flag that causes the loop to exit after the current
 * tick finishes. It never interrupts a tick mid-execution.
 */

import { PublicKey } from '@solana/web3.js';
import { safePublicKey } from '../utils.js';
import type { WalletClient } from '../wallet/types.js';
import type { AdapterRegistry } from '../protocols/types.js';
import type { Logger } from '../logger/logger.js';
import type { AuditDb } from '../logger/audit.js';
import type {
  AgentConfig,
  AgentLoopState,
  AgentState,
  Strategy,
} from './types.js';

// ── AgentLoop ─────────────────────────────────────────────────────────────────

export class AgentLoop {
  private stopped = false;
  private tickCount = 0;
  private lastTickAt: Date | null = null;
  private lastActionAt: Date | null = null;
  private lastError: string | null = null;
  private startedAt: Date | null = null;
  private status: 'idle' | 'running' | 'stopped' | 'error' = 'idle';

  constructor(
    private readonly config: AgentConfig,
    private readonly wallet: WalletClient,
    private readonly strategy: Strategy,
    private readonly adapters: AdapterRegistry,
    private readonly logger: Logger,
    private readonly auditDb: AuditDb,
  ) { }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Starts the agent loop. Returns a Promise that resolves when stop() is called
   * and the current tick finishes. Never rejects — all errors are caught internally.
   */
  async start(): Promise<void> {
    if (this.status === 'running') {
      this.logger.warn({ agentId: this.config.id }, 'AgentLoop.start() called on already-running loop');
      return;
    }

    this.stopped = false;
    this.status = 'running';
    this.startedAt = new Date();

    this.auditDb.log(
      this.config.id,
      this.wallet.publicKey.toBase58(),
      'agent_start',
      { strategy: this.config.strategy, intervalMs: this.config.intervalMs },
    );

    this.logger.info(
      { agentId: this.config.id, strategy: this.config.strategy, intervalMs: this.config.intervalMs },
      'Agent started',
    );

    while (!this.stopped) {
      await this.tick();
      if (!this.stopped) {
        await sleep(this.config.intervalMs);
      }
    }

    this.status = 'stopped';

    this.auditDb.log(
      this.config.id,
      this.wallet.publicKey.toBase58(),
      'agent_stop',
      { tickCount: this.tickCount, strategy: this.config.strategy },
    );

    this.logger.info({ agentId: this.config.id, tickCount: this.tickCount }, 'Agent stopped');
  }

  /**
   * Signals the loop to stop after the current tick finishes.
   * Returns immediately — does not wait for the tick to complete.
   */
  stop(): void {
    this.stopped = true;
    this.logger.info({ agentId: this.config.id }, 'Agent stop requested');
  }

  /** Returns a snapshot of the agent's current observable state. */
  getState(): AgentLoopState {
    return {
      agentId: this.config.id,
      status: this.status,
      walletPubkey: this.wallet.publicKey.toBase58(),
      strategy: this.config.strategy,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      lastActionAt: this.lastActionAt,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  /**
   * Executes one complete tick: gather → decide → execute → audit.
   * NEVER throws — all errors are caught, logged, and the loop continues.
   */
  private async tick(): Promise<void> {
    this.tickCount++;
    this.lastTickAt = new Date();

    this.logger.debug({ agentId: this.config.id, tick: this.tickCount }, 'Tick start');

    // 0. Check for remote stop signal from CLI
    const recentStopSignal = this.auditDb.query({
      agentId: this.config.id,
      event: 'system_stop_request',
      limit: 1
    })[0];

    if (recentStopSignal) {
      let details: any = {};
      try { details = JSON.parse(recentStopSignal.details_json); } catch { }

      const signalTime = details.request_ts || new Date(recentStopSignal.ts).getTime();
      const loopStartTime = this.startedAt?.getTime() ?? 0;

      this.logger.debug({
        agentId: this.config.id,
        signalTime,
        loopStartTime,
        diff: signalTime - loopStartTime
      }, 'Checking for stop signal');

      // Only obey signals sent AFTER this loop instance started (with a 2s safety buffer)
      if (signalTime > (loopStartTime - 2000)) {
        this.logger.warn({ agentId: this.config.id, signalTime, loopStartTime }, 'Received valid stop signal — shutting down');
        this.status = 'stopped';
        this.auditDb.log(this.config.id, this.wallet.publicKey.toBase58(), 'agent_stop', {
          reason: 'Remote stop signal received',
          signalId: recentStopSignal.id,
          tick: this.tickCount
        });
        return;
      }
    }

    let state: AgentState | undefined;
    try {
      // 1. Gather on-chain state
      state = await this.gatherState();

      // 2. Strategy decides what to do
      const action = await this.strategy.decide(state);

      // 3. Noop — log and skip execution
      if (action.type === 'noop') {
        this.logger.debug(
          { agentId: this.config.id, tick: this.tickCount, rationale: action.rationale },
          'Tick: noop',
        );

        this.auditDb.log(
          this.config.id,
          this.wallet.publicKey.toBase58(),
          'agent_noop',
          {
            tick: this.tickCount,
            strategy: this.config.strategy,
            rationale: action.rationale,
            solBalance: state.solBalance.toString(),
          },
        );
        return;
      }

      // 4. Execute the action
      this.logger.info(
        {
          agentId: this.config.id,
          tick: this.tickCount,
          action: action.type,
          rationale: action.rationale,
          params: sanitiseParams(action.params),
        },
        'Tick: executing action',
      );

      const result = await this.strategy.execute(action, this.wallet, this.adapters);
      this.lastActionAt = new Date();

      // 5. Audit the result
      const eventType = !result
        ? 'agent_action'
        : result.status === 'confirmed'
          ? 'tx_confirmed'
          : result.status === 'failed'
            ? 'tx_failed'
            : 'tx_timeout';

      this.auditDb.log(
        this.config.id,
        this.wallet.publicKey.toBase58(),
        eventType,
        {
          tick: this.tickCount,
          strategy: this.config.strategy,
          action: action.type,
          rationale: action.rationale,
          params: sanitiseParams(action.params),
          solBalance: state.solBalance.toString(),
        },
        result
          ? { signature: result.signature, status: result.status }
          : undefined,
      );

      this.logger.info(
        {
          agentId: this.config.id,
          tick: this.tickCount,
          action: action.type,
          status: result?.status,
          signature: result?.signature,
        },
        'Tick: action complete',
      );

    } catch (err) {
      // CRASH ISOLATION: catch everything, never rethrow
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode = (err as Record<string, unknown>)['code'] as string | undefined;

      this.lastError = errMsg;

      this.logger.error(
        { agentId: this.config.id, tick: this.tickCount, err: errMsg, code: errCode },
        'Tick failed — loop continues',
      );

      const eventType = errCode === 'LIMIT_BREACH' ? 'limit_breach' : 'agent_error';

      this.auditDb.log(
        this.config.id,
        this.wallet.publicKey.toBase58(),
        eventType,
        {
          tick: this.tickCount,
          strategy: this.config.strategy,
          error: errMsg,
          code: errCode ?? null,
          solBalance: state ? state.solBalance.toString() : null,
        },
      );
    }
  }

  // ── State gathering ─────────────────────────────────────────────────────────

  /**
   * Fetches the current on-chain state needed by the strategy.
   * This is the only place the agent touches the chain for reads.
   */
  private async gatherState(): Promise<AgentState> {
    const [solBalance] = await Promise.all([
      this.wallet.getSolBalance(),
    ]);

    // Gather token balances for mints the strategy cares about
    const tokenBalances = new Map<string, bigint>();
    const trackedMints = this.getTrackedMints();

    if (trackedMints.length > 0) {
      await Promise.all(
        trackedMints.map(async (mintStr) => {
          try {
            const mint = safePublicKey(mintStr);
            const balance = await this.wallet.getTokenBalance(mint);
            tokenBalances.set(mintStr, balance);
          } catch {
            tokenBalances.set(mintStr, 0n);
          }
        }),
      );
    }

    return {
      agentId: this.config.id,
      walletPubkey: this.wallet.publicKey.toBase58(),
      solBalance,
      tokenBalances,
      lastActionAt: this.lastActionAt,
      tickCount: this.tickCount,
      snapshotAt: Date.now(),
    };
  }

  /** Extracts mint addresses this strategy cares about from strategyParams. */
  private getTrackedMints(): string[] {
    const params = this.config.strategyParams;
    const mints: string[] = [];

    if (typeof params['targetMint'] === 'string') mints.push(params['targetMint']);
    if (Array.isArray(params['trackedMints'])) {
      for (const m of params['trackedMints']) {
        if (typeof m === 'string') mints.push(m);
      }
    }

    return mints;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sanitises action params before writing to the audit log.
 * Converts BigInt values to strings and strips key-adjacent fields.
 */
function sanitiseParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'bigint') {
      result[k] = v.toString();
    } else if (typeof v !== 'function') {
      result[k] = v;
    }
  }
  return result;
}
