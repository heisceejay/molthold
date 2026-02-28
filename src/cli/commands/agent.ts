/**
 * @file src/cli/commands/agent.ts
 *
 * Agent subcommand group:
 *
 *   agentw agent start  --config <path>          # launch all agents from JSON file
 *   agentw agent start  --name <id> --strategy <s> [--interval <ms>]  # launch one
 *   agentw agent status [--name <id>]            # show live loop state
 *   agentw agent log    --name <id> [--last <n>] # query audit DB events
 *
 * `agent start` is a long-running process. SIGINT/SIGTERM trigger manager.stop()
 * then process.exit(0). The audit DB is always flushed before exit.
 */

import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { env, spendingLimits } from '../../config/env.js';
import { MultiAgentManager, loadAgentConfigs } from '../../agent/manager.js';
import { AuditDb } from '../../logger/audit.js';
import { createLogger } from '../../logger/logger.js';
import {
  header, subheader, success, info, warn, kv, table,
  formatBalance, formatAuditRows, errorAndExit, fatalError, printLine, c,
} from '../output.js';
import type { AgentConfig } from '../../agent/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveAuditDbPath(flagPath?: string): string {
  return path.resolve(flagPath ?? env.AUDIT_DB_PATH);
}

function resolveConfigPath(flagPath?: string): string {
  return path.resolve(flagPath ?? env.AGENTS_CONFIG_PATH);
}

// ── agent start ───────────────────────────────────────────────────────────────

const startCmd = new Command('start')
  .description('Start one or more agent loops')
  .option('--config <path>', 'Path to agents.json config file')
  .option('--name <id>', 'Agent ID (for single-agent mode)')
  .option('--strategy <name>', 'Strategy name: dca | rebalancer | monitor | market_maker (single-agent mode)')
  .option('--interval <ms>', 'Tick interval in ms (single-agent mode)', '30000')
  .option('--keystore <path>', 'Keystore file path (single-agent mode)')
  .option('--db <path>', 'Audit DB path (overrides AUDIT_DB_PATH)')
  .option('--log-level <level>', 'Log level: trace|debug|info|warn|error', 'info')
  .action(async (opts: {
    config?: string;
    name?: string;
    strategy?: string;
    interval?: string;
    keystore?: string;
    db?: string;
    logLevel?: string;
  }) => {
    const logger = createLogger({ level: opts.logLevel ?? 'info' });
    const dbPath = resolveAuditDbPath(opts.db);
    const rpcUrl = env.SOLANA_RPC_URL;

    // Build agent config array from either --config file or single-agent flags
    let configs: AgentConfig[];

    if (opts.config) {
      const configPath = resolveConfigPath(opts.config);
      try {
        configs = loadAgentConfigs(configPath);
      } catch (err) {
        fatalError(err, `Loading config from ${configPath}`);
      }
    } else if (opts.name && opts.strategy) {
      // Single-agent shorthand
      if (!['dca', 'rebalancer', 'monitor', 'market_maker'].includes(opts.strategy)) {
        errorAndExit(`Unknown strategy "${opts.strategy}". Must be: dca, rebalancer, monitor, or market_maker`);
      }

      const keystorePath = opts.keystore
        ?? path.resolve(process.cwd(), 'keystores', `${opts.name}.keystore.json`);

      if (!fs.existsSync(keystorePath)) {
        errorAndExit(
          `Keystore not found at ${keystorePath}. ` +
          `Create it first with: agentw wallet create --name ${opts.name}`,
        );
      }

      // Supply dummy strategyParams required by validation for single-agent shorthand 
      const strategyParams: Record<string, any> = {};
      if (opts.strategy === 'dca') {
        strategyParams['targetMint'] = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // Devnet USDC
        strategyParams['amountPerTickLamports'] = 50_000_000;
      } else if (opts.strategy === 'rebalancer') {
        strategyParams['targetMint'] = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
        strategyParams['solTargetPercentage'] = 0.5;
        strategyParams['tolerancePercentage'] = 0.05;
      } else if (opts.strategy === 'market_maker') {
        strategyParams['targetMint'] = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
        strategyParams['amountSolLamports'] = 10_000_000;
        strategyParams['amountToken'] = 1_000_000;
      }

      configs = [{
        id: opts.name,
        keystorePath,
        strategy: opts.strategy as AgentConfig['strategy'],
        strategyParams,
        intervalMs: parseInt(opts.interval ?? '30000', 10),
        limits: spendingLimits,
      }];
    } else {
      errorAndExit(
        'Provide either --config <path> or both --name <id> and --strategy <name>.',
      );
    }

    header('Molthold — Agent Start');

    info(`RPC:       ${rpcUrl}`);
    info(`Audit DB:  ${dbPath}`);
    info(`Agents:    ${configs!.length}`);
    printLine('');

    const manager = new MultiAgentManager(configs!, logger, rpcUrl, dbPath);

    // ── Graceful shutdown ───────────────────────────────────────────────────
    let stopping = false;

    async function shutdown(signal: string): Promise<void> {
      if (stopping) return;
      stopping = true;
      printLine('');
      warn(`Received ${signal} — stopping all agents…`);
      await manager.stop();
      success('All agents stopped. Audit DB flushed.');
      process.exit(0);
    }

    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

    // ── Start ───────────────────────────────────────────────────────────────
    try {
      await manager.start();
    } catch (err) {
      fatalError(err, 'manager.start()');
    }

    // manager.start() returns immediately — process stays alive via signal handlers
    // Print periodic status every 30s if stdout is not a TTY (CI/log-redirect mode)
    if (!process.stdout.isTTY) {
      setInterval(() => {
        const states = manager.getAgentStates();
        for (const s of states) {
          logger.info({
            agentId: s.agentId,
            status: s.status,
            ticks: s.tickCount,
            lastError: s.lastError,
          }, 'agent status');
        }
      }, 30_000);
    }

    // Keep process alive
    await new Promise<void>(() => { /* resolved by signal handler */ });
  });

// ── agent status ──────────────────────────────────────────────────────────────

const statusCmd = new Command('status')
  .description('Show the current state of agent loops (reads from audit DB)')
  .option('--name <id>', 'Filter to a single agent')
  .option('--db <path>', 'Audit DB path')
  .action((opts: { name?: string; db?: string }) => {
    const dbPath = resolveAuditDbPath(opts.db);

    if (!fs.existsSync(dbPath)) {
      info('No audit DB found — no agents have run yet.');
      info(`Expected path: ${dbPath}`);
      printLine('');
      return;
    }

    const db = new AuditDb(dbPath);

    try {
      header('Agent Status');

      const summary = db.summarise();

      if (summary.length === 0) {
        info('No audit events recorded yet.');
        printLine('');
        return;
      }

      // Group by agent_id
      const agentIds = opts.name
        ? [opts.name]
        : [...new Set(summary.map((r) => r.agent_id))];

      for (const agentId of agentIds) {
        subheader(`Agent: ${agentId}`);

        const agentRows = summary.filter((r) => r.agent_id === agentId);
        const rows = agentRows.map((r) => [r.event, String(r.count)]);

        table(['Event', 'Count'], rows);

        // Show most recent event
        const recent = db.query({ agentId, limit: 1 });
        if (recent[0]) {
          printLine('');
          info(`Last event: ${recent[0].event} at ${new Date(recent[0].ts).toLocaleString()}`);
          if (recent[0].status) {
            info(`Last status: ${recent[0].status}`);
          }
        }
        printLine('');
      }
    } finally {
      db.close();
    }
  });

// ── agent log ─────────────────────────────────────────────────────────────────

const logCmd = new Command('log')
  .description('Query and display audit log events')
  .option('--name <id>', 'Filter by agent ID')
  .option('--last <n>', 'Number of most recent events to show', '20')
  .option('--event <type>', 'Filter by event type (e.g. tx_confirmed, agent_error)')
  .option('--db <path>', 'Audit DB path')
  .option('--json', 'Output raw JSON (one object per line)')
  .action((opts: {
    name?: string;
    last?: string;
    event?: string;
    db?: string;
    json?: boolean;
  }) => {
    const dbPath = resolveAuditDbPath(opts.db);

    if (!fs.existsSync(dbPath)) {
      info('No audit DB found — no agents have run yet.');
      info(`Expected path: ${dbPath}`);
      printLine('');
      return;
    }

    const db = new AuditDb(dbPath);

    try {
      const limit = Math.min(parseInt(opts.last ?? '20', 10), 500);

      const queryOpts: any = { limit };
      if (opts.name) queryOpts.agentId = opts.name;
      if (opts.event) queryOpts.event = opts.event;
      const rows = db.query(queryOpts);

      if (opts.json) {
        // Machine-readable output
        for (const row of rows) {
          process.stdout.write(JSON.stringify(row) + '\n');
        }
        return;
      }

      header(`Audit Log${opts.name ? ` — ${opts.name}` : ''}`);

      if (opts.name) kv([['Agent', opts.name]]);
      if (opts.event) kv([['Filter', opts.event]]);
      kv([['Showing', `${rows.length} of last ${limit} events`]]);
      printLine('');

      formatAuditRows(rows);
      printLine('');
    } finally {
      db.close();
    }
  });

// ── agent stop ────────────────────────────────────────────────────────────────

const stopCmd = new Command('stop')
  .description('Signal a running agent to stop gracefully (across processes)')
  .requiredOption('--name <id>', 'Agent ID to stop')
  .option('--db <path>', 'Audit DB path')
  .action((opts: { name: string; db?: string }) => {
    const dbPath = resolveAuditDbPath(opts.db);

    if (!fs.existsSync(dbPath)) {
      errorAndExit(`No audit DB found at ${dbPath}. No agents are running.`);
    }

    const db = new AuditDb(dbPath);
    try {
      header(`Stopping Agent: ${opts.name}`);

      // Check if agent has any history first
      const recent = db.query({ agentId: opts.name, limit: 1 });
      if (recent.length === 0) {
        warn(`Agent "${opts.name}" has never been recorded in this DB.`);
      }

      // Write the stop signal
      db.log(opts.name, 'SIGNAL', 'system_stop_request', {
        request_ts: Date.now(),
        requestedBy: 'cli',
        reason: 'User manual stop'
      });

      success(`Stop signal sent to agent "${opts.name}".`);
      info('The agent will shut down at the start of its next tick.');
    } finally {
      db.close();
    }
  });

// ── agent command group ───────────────────────────────────────────────────────

export const agentCommand = new Command('agent')
  .description('Manage and monitor autonomous agents')
  .addCommand(startCmd)
  .addCommand(statusCmd)
  .addCommand(logCmd)
  .addCommand(stopCmd);
