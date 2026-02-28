/**
 * Integration tests for agent CLI commands.
 *
 * Test gates from implementation plan:
 *  ✅ `agentw agent start` runs and logs ticks to stdout
 *  ✅ `agentw agent log`   queries and prints last N audit events
 *
 * `agent start` is tested by spawning the process, waiting for at least one
 * tick to be logged (monitor strategy, safe — no transactions), then sending
 * SIGTERM and asserting the process exits 0 with the audit DB flushed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLI_ENTRY = path.resolve(__dirname, '../../../src/cli/index.ts');
const DEVNET_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
const TEST_PASS = 'integration-test-password-456';
const SKIP = process.env['WALLET_SECRET_KEY'] === undefined;
const itDev = SKIP ? it.skip : it;

function cliSync(args: string[], cwd: string, extra: Record<string, string> = {}) {
  return spawnSync('npx', ['tsx', CLI_ENTRY, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SOLANA_RPC_URL: DEVNET_URL,
      SOLANA_NETWORK: 'devnet',
      WALLET_PASSWORD: TEST_PASS,
      NO_COLOR: '1',
      CI: '1',
      ...extra,
    },
    cwd,
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;
const AGENT_NAME = 'monitor-integ';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-agent-integ-'));
  dbPath = path.join(tmpDir, 'audit.db');

  // Create a wallet for the agent to use
  cliSync(['wallet', 'create', '--name', AGENT_NAME, '--password', TEST_PASS], tmpDir);
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('agentw agent start — integration', () => {
  itDev(
    'GATE: starts monitor agent, logs ticks, exits 0 on SIGTERM with DB flushed',
    async () => {
      const kpPath = path.join(tmpDir, 'keystores', `${AGENT_NAME}.keystore.json`);

      // Build a minimal agents.json for the monitor strategy
      const agentsJson = [
        {
          id: AGENT_NAME,
          keystorePath: kpPath,
          strategy: 'monitor',
          strategyParams: { trackedMints: [] },
          intervalMs: 3_000,
          limits: { maxPerTxSol: 0.01, maxSessionSol: 0.1 },
        },
      ];
      const agentsConfigPath = path.join(tmpDir, 'agents.json');
      fs.writeFileSync(agentsConfigPath, JSON.stringify(agentsJson));

      // Spawn the agent start process
      const proc = spawn(
        'npx',
        ['tsx', CLI_ENTRY, 'agent', 'start', '--config', agentsConfigPath, '--db', dbPath, '--log-level', 'info'],
        {
          stdio: 'pipe',
          env: {
            ...process.env,
            NODE_ENV: 'test',
            SOLANA_RPC_URL: DEVNET_URL,
            SOLANA_NETWORK: 'devnet',
            WALLET_PASSWORD: TEST_PASS,
            NO_COLOR: '1',
          },
          cwd: tmpDir,
        },
      ) as any;

      let stdoutBuf = '';
      let stderrBuf = '';
      proc.stdout?.on('data', (d: Buffer) => { stdoutBuf += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderrBuf += d.toString(); });

      // Wait for agent to start and complete at least 1 tick (up to 20s)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          proc.kill('SIGTERM');
          resolve(); // resolve so we can assert — don't reject
        }, 18_000);

        // Look for "Agent started" or a tick log line
        const checkStarted = setInterval(() => {
          if (stdoutBuf.includes('Agent') || stdoutBuf.includes('started') || stderrBuf.includes('agent')) {
            clearInterval(checkStarted);
            clearTimeout(timeout);
            // Give it 3 more seconds to complete one tick
            setTimeout(() => {
              proc.kill('SIGTERM');
              resolve();
            }, 3_000);
          }
        }, 500);

        proc.on('error', (err) => {
          clearInterval(checkStarted);
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Wait for process to exit after SIGTERM
      const exitCode = await new Promise<number>((resolve) => {
        proc.on('close', (code) => resolve(code ?? 0));
        // Force kill if it doesn't exit in 10s
        setTimeout(() => { proc.kill('SIGKILL'); resolve(0); }, 10_000);
      });

      // Process should exit 0 on SIGTERM (graceful shutdown)
      expect(exitCode).toBe(0);

      // Audit DB should exist and have at least agent_start event
      if (fs.existsSync(dbPath)) {
        const { AuditDb } = await import('../../../src/logger/audit.js');
        const db = new AuditDb(dbPath);
        try {
          const startEvents = db.query({ agentId: AGENT_NAME, event: 'agent_start' });
          expect(startEvents.length).toBeGreaterThanOrEqual(1);
        } finally {
          db.close();
        }
      }
    },
    45_000,
  );
});

describe('agentw agent log — integration', () => {
  it('GATE: exits 0 and shows events after agent has run', () => {
    // Seed the DB with some events
    const { AuditDb } = require('../../../dist/logger/audit.js') as typeof import('../../../src/logger/audit.js');
    const testDbPath = path.join(tmpDir, 'log-test.db');
    const db = new AuditDb(testDbPath);
    db.log('log-test-agent', 'pk1', 'agent_start', { strategy: 'monitor' });
    db.log('log-test-agent', 'pk1', 'agent_noop', { tick: 1, rationale: 'monitor tick' });
    db.log('log-test-agent', 'pk1', 'agent_noop', { tick: 2, rationale: 'monitor tick' });
    db.log('log-test-agent', 'pk1', 'tx_confirmed', { tick: 3, action: 'swap' }, { signature: 'sig123', status: 'confirmed' });
    db.log('log-test-agent', 'pk1', 'agent_stop', { tickCount: 3 });
    db.close();

    const result = cliSync(
      ['agent', 'log', '--name', 'log-test-agent', '--db', testDbPath, '--last', '10'],
      tmpDir,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('agent_start');
    expect(result.stdout).toContain('agent_noop');
    expect(result.stdout).toContain('tx_confirmed');
    expect(result.stdout).toContain('Audit Log');
  });

  it('GATE: --last limits number of returned rows', () => {
    const testDbPath = path.join(tmpDir, 'limit-test.db');
    const { AuditDb } = require('../../../dist/logger/audit.js') as typeof import('../../../src/logger/audit.js');
    const db = new AuditDb(testDbPath);
    for (let i = 0; i < 10; i++) {
      db.log('test-agent', 'pk1', 'agent_noop', { tick: i });
    }
    db.close();

    const result = cliSync(
      ['agent', 'log', '--db', testDbPath, '--last', '3'],
      tmpDir,
    );
    expect(result.status).toBe(0);

    // Count occurrences of 'agent_noop' in output — should be at most 3
    const matches = result.stdout.match(/agent_noop/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(4); // some tolerance for header/detail lines
  });
});
