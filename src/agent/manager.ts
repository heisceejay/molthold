/**
 * @file src/agent/manager.ts
 *
 * MultiAgentManager — launches and supervises N independent agent instances.
 *
 * ISOLATION GUARANTEE: Each agent receives its own WalletClient constructed
 * from its own keystore file. Agents share:
 *   - One Connection object (RPC connection pooling)
 *   - One Logger (with agentId bound per child logger)
 *   - One AuditDb
 *
 * Agents share NOTHING ELSE. In particular:
 *   - Each WalletClient is constructed independently
 *   - Each SpendingLimitGuard is independent
 *   - Each strategy instance is independent
 *
 * LIFECYCLE: start() launches all loops concurrently and does NOT await them.
 * The loops run until stop() is called. stop() signals all loops and waits
 * for all of them to finish their current tick.
 */

import { Connection } from '@solana/web3.js';
import { createWalletClient } from '../wallet/wallet.js';
import { loadKeystore, loadFromEnv } from '../wallet/keystore.js';
import { createAdapterRegistry } from '../protocols/index.js';
import { AgentLoop } from './loop.js';
import { createStrategy } from './strategies/index.js';
import { createAgentLogger } from '../logger/logger.js';
import { AuditDb } from '../logger/audit.js';
import type { WalletConfig } from '../wallet/types.js';
import type { Logger } from '../logger/logger.js';
import type { AgentConfig, AgentLoopState } from './types.js';

// ── Manager ───────────────────────────────────────────────────────────────────

export class MultiAgentManager {
  private loops: Map<string, AgentLoop> = new Map();
  private loopTasks: Promise<void>[] = [];
  private started = false;
  private auditDb: AuditDb;

  constructor(
    private readonly configs: AgentConfig[],
    private readonly logger: Logger,
    private readonly rpcUrl: string,
    auditDbPath: string,
  ) {
    this.auditDb = new AuditDb(auditDbPath);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Constructs all agent loops and starts them concurrently.
   * Returns immediately — loops run in the background.
   */
  async start(): Promise<void> {
    if (this.started) {
      this.logger.warn('MultiAgentManager.start() called more than once');
      return;
    }
    this.started = true;

    this.logger.info({ agentCount: this.configs.length }, 'MultiAgentManager: starting all agents');

    const connection = new Connection(this.rpcUrl, 'confirmed');
    const adapters = createAdapterRegistry(connection, this.logger);

    for (const config of this.configs) {
      const agentLogger = createAgentLogger(
        this.logger,
        config.id,
        '[loading]', // placeholder until wallet loaded
      );

      // Build WalletClient — each agent gets its own isolated instance
      const keypair = this.loadKeypair(config);
      const walletConfig: WalletConfig = {
        rpcUrl: this.rpcUrl,
        limits: config.limits,
        simulateBeforeSend: true,
        confirmationStrategy: 'confirmed',
        maxRetries: 3,
        retryDelayMs: 2_000,
      };

      const wallet = createWalletClient(
        keypair,
        walletConfig,
        createAgentLogger(this.logger, config.id, keypair.publicKey.toBase58()),
      );

      const strategy = createStrategy(config.strategy, config.strategyParams, this.rpcUrl);

      const loop = new AgentLoop(
        config,
        wallet,
        strategy,
        adapters,
        createAgentLogger(this.logger, config.id, wallet.publicKey.toBase58()),
        this.auditDb,
      );

      this.loops.set(config.id, loop);

      // Launch without awaiting — loops run until stop() is called
      const task = loop.start().catch((err) => {
        // Should never happen (loop catches internally), but belt-and-suspenders
        this.logger.error({ agentId: config.id, err }, 'Agent loop promise rejected unexpectedly');
      });

      this.loopTasks.push(task);
      agentLogger.info({ agentId: config.id, strategy: config.strategy }, 'Agent loop launched');
    }
  }

  /**
   * Signals all running loops to stop, then waits for all to finish
   * their current tick. Returns when all agents have stopped.
   */
  async stop(): Promise<void> {
    this.logger.info('MultiAgentManager: stopping all agents…');

    for (const loop of this.loops.values()) {
      loop.stop();
    }

    // Wait for all loops to finish their current tick
    await Promise.allSettled(this.loopTasks);

    this.auditDb.close();
    this.logger.info('MultiAgentManager: all agents stopped, audit DB closed');
  }

  // ── Observability ───────────────────────────────────────────────────────────

  /** Returns the current state of all agent loops. */
  getAgentStates(): AgentLoopState[] {
    return Array.from(this.loops.values()).map((loop) => loop.getState());
  }

  /** Returns the state of a single agent by ID. */
  getAgentState(agentId: string): AgentLoopState | undefined {
    return this.loops.get(agentId)?.getState();
  }

  /** Exposes the AuditDb for queries (e.g. from the CLI). */
  getAuditDb(): AuditDb { return this.auditDb; }

  // ── Private ─────────────────────────────────────────────────────────────────

  private loadKeypair(config: AgentConfig): ReturnType<typeof loadKeystore> {
    const password = process.env['WALLET_PASSWORD'];

    // In test/dev environments, allow loading from env var
    const envKey = process.env[`WALLET_SECRET_KEY_${config.id.toUpperCase().replace(/-/g, '_')}`]
      ?? (this.configs.length === 1 ? process.env['WALLET_SECRET_KEY'] : undefined);

    if (envKey) {
      return loadFromEnv(envKey);
    }

    if (!password) {
      throw new Error(
        `Cannot load wallet for agent ${config.id}: ` +
        `WALLET_PASSWORD env var is not set and no WALLET_SECRET_KEY_${config.id.toUpperCase()} found. ` +
        `Set WALLET_PASSWORD or pass --password to the CLI.`,
      );
    }

    return loadKeystore(config.keystorePath, password);
  }
}

// ── Convenience: load agent configs from JSON file ────────────────────────────

import * as fs from 'node:fs';
import { z } from 'zod';

const agentConfigSchema = z.object({
  id: z.string().min(1),
  keystorePath: z.string().min(1),
  strategy: z.enum(['dca', 'rebalancer', 'monitor', 'market_maker']),
  strategyParams: z.record(z.unknown()),
  intervalMs: z.number().positive(),
  limits: z.object({
    maxPerTxSol: z.number().positive().optional(),
    maxSessionSol: z.number().positive().optional(),
    // Also accept lamport bigint strings for precision
    maxPerTxLamports: z.union([z.string(), z.number()]).optional(),
    maxSessionLamports: z.union([z.string(), z.number()]).optional(),
  }),
});

const SOL_TO_LAMPORTS = 1_000_000_000n;

export function loadAgentConfigs(configPath: string): AgentConfig[] {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Agent config file not found: ${configPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown[];
  if (!Array.isArray(raw)) throw new Error('agents.json must be an array');

  return raw.map((item, i) => {
    const parsed = agentConfigSchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(`agents.json[${i}] is invalid: ${parsed.error.message}`);
    }

    const { limits } = parsed.data;

    // Convert SOL values to lamports bigints
    const maxPerTxLamports = limits.maxPerTxLamports
      ? BigInt(String(limits.maxPerTxLamports))
      : BigInt(Math.round((limits.maxPerTxSol ?? 0.1) * Number(SOL_TO_LAMPORTS)));

    const maxSessionLamports = limits.maxSessionLamports
      ? BigInt(String(limits.maxSessionLamports))
      : BigInt(Math.round((limits.maxSessionSol ?? 1.0) * Number(SOL_TO_LAMPORTS)));

    return {
      ...parsed.data,
      limits: {
        maxPerTxLamports,
        maxSessionLamports,
      },
    } satisfies AgentConfig;
  });
}
