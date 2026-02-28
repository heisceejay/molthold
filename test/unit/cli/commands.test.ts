/**
 * Unit tests for CLI command logic.
 *
 * Tests use child_process.spawnSync to invoke the CLI via tsx so we can:
 *  - Assert exit codes
 *  - Assert stdout/stderr content
 *  - Remain process-isolated (no mock bleed between tests)
 *
 * All tests that would hit devnet are moved to test/integration/cli/.
 *
 * Test gates (unit):
 *  ✅ `agentw wallet list`   exits 0 when keystores/ doesn't exist
 *  ✅ `agentw wallet create` exits 1 when name contains invalid chars
 *  ✅ `agentw wallet create` exits 1 when password is too short
 *  ✅ `agentw wallet balance` exits 1 when wallet not found
 *  ✅ `agentw agent log`     exits 0 and prints "no agents" when DB absent
 *  ✅ `agentw agent status`  exits 0 and prints "no agents" when DB absent
 *  ✅ `agentw --help`        exits 0 and lists commands
 *  ✅ `agentw wallet --help` exits 0 and lists wallet subcommands
 *  ✅ Audit DB details_json never contains key-adjacent strings (re-asserted here)
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLI_ENTRY = path.resolve(__dirname, '../../../src/cli/index.ts');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

/** Run the CLI synchronously and return { stdout, stderr, status }. */
function cli(
  args: string[],
  env: Record<string, string> = {},
  cwd: string = PROJECT_ROOT,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(
    'npx',
    ['tsx', CLI_ENTRY, ...args],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SOLANA_RPC_URL: 'https://api.devnet.solana.com',
        SOLANA_NETWORK: 'devnet',
        NO_COLOR: '1',   // disable ANSI codes for easier assertion
        CI: '1',
        ...env,
      },
      cwd,
    },
  );

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

// ── Top-level help ────────────────────────────────────────────────────────────

describe('agentw --help', () => {
  it('exits 0 and lists wallet and agent commands', () => {
    const { stdout, status } = cli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('wallet');
    expect(stdout).toContain('agent');
  });

  it('prints version with --version', () => {
    const { stdout, status } = cli(['--version']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  });
});

// ── wallet --help ─────────────────────────────────────────────────────────────

describe('agentw wallet --help', () => {
  it('exits 0 and lists all wallet subcommands', () => {
    const { stdout, status } = cli(['wallet', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('create');
    expect(stdout).toContain('balance');
    expect(stdout).toContain('airdrop');
    expect(stdout).toContain('transfer');
    expect(stdout).toContain('list');
  });
});

// ── agentw wallet list ────────────────────────────────────────────────────────

describe('agentw wallet list', () => {
  it('exits 0 even when keystores/ directory does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      const { status, stdout } = cli(['wallet', 'list'], {}, tmpDir);
      expect(status).toBe(0);
      // Should say no wallets found or similar
      expect(stdout.toLowerCase()).toMatch(/no wallets|no keystores/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits 0 when keystores/ exists but is empty', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'keystores'));
      const { status } = cli(['wallet', 'list'], {}, tmpDir);
      expect(status).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── agentw wallet create — validation ─────────────────────────────────────────

describe('agentw wallet create — validation', () => {
  it('GATE: exits 1 for invalid wallet name (spaces)', () => {
    const { stderr, status } = cli([
      'wallet', 'create', '--name', 'my wallet', '--password', 'password123',
    ]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/name|invalid/i);
  });

  it('GATE: exits 1 for invalid wallet name (special chars)', () => {
    const { stderr, status } = cli([
      'wallet', 'create', '--name', 'wallet!@#', '--password', 'password123',
    ]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/name|invalid/i);
  });

  it('GATE: exits 1 when password is too short', () => {
    const { stderr, status } = cli([
      'wallet', 'create', '--name', 'test-wallet', '--password', 'short',
    ]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/password|8 char/i);
  });

  it('exits 1 when wallet name already exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      // Pre-create the keystore file
      const ksDir = path.join(tmpDir, 'keystores');
      fs.mkdirSync(ksDir);
      fs.writeFileSync(path.join(ksDir, 'existing.keystore.json'), '{}');

      const { stderr, status } = cli(
        ['wallet', 'create', '--name', 'existing', '--password', 'password123'],
        {},
        tmpDir,
      );
      expect(status).toBe(1);
      expect(stderr).toMatch(/already exists/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── agentw wallet balance — validation ────────────────────────────────────────

describe('agentw wallet balance', () => {
  it('GATE: exits 1 when wallet not found', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      const { stderr, status } = cli(
        ['wallet', 'balance', '--name', 'nonexistent', '--password', 'password123'],
        {},
        tmpDir,
      );
      expect(status).toBe(1);
      expect(stderr).toMatch(/not found|nonexistent/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── agentw wallet airdrop — validation ────────────────────────────────────────

describe('agentw wallet airdrop', () => {
  it('exits 1 for invalid amount (> 2 SOL)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      const ksDir = path.join(tmpDir, 'keystores');
      fs.mkdirSync(ksDir);
      fs.writeFileSync(path.join(ksDir, 'alice.keystore.json'), JSON.stringify({
        version: 1, publicKey: 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW', encrypted: {},
      }));

      const { stderr, status } = cli(
        ['wallet', 'airdrop', '--name', 'alice', '--amount', '5'],
        {},
        tmpDir,
      );
      expect(status).toBe(1);
      expect(stderr).toMatch(/2 SOL|amount/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── agentw agent log — no DB ──────────────────────────────────────────────────

describe('agentw agent log', () => {
  it('GATE: exits 0 and prints helpful message when audit DB does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      const { stdout, status } = cli(
        ['agent', 'log', '--db', path.join(tmpDir, 'nonexistent.db')],
        {},
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout.toLowerCase()).toMatch(/no audit|no agents|not found/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('GATE: exits 0 and prints events when DB has data', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      // Create a DB with some test events
      const { AuditDb } = await import('../../../src/logger/audit.js');
      const dbPath = path.join(tmpDir, 'test.db');
      const db = new AuditDb(dbPath);
      db.log('agent-1', 'pubkey123', 'tx_confirmed', { tick: 1, action: 'swap' }, { signature: 'sig1', status: 'confirmed' });
      db.log('agent-1', 'pubkey123', 'agent_noop', { tick: 2, rationale: 'low balance' });
      db.close();

      const { stdout, status } = cli(
        ['agent', 'log', '--name', 'agent-1', '--db', dbPath],
        {},
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('tx_confirmed');
      expect(stdout).toContain('agent_noop');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('--json flag outputs one JSON object per line', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      const { AuditDb } = await import('../../../src/logger/audit.js');
      const dbPath = path.join(tmpDir, 'test.db');
      const db = new AuditDb(dbPath);
      db.log('agent-1', 'pk1', 'agent_noop', { tick: 1 });
      db.close();

      const { stdout, status } = cli(
        ['agent', 'log', '--db', dbPath, '--json'],
        {},
        tmpDir,
      );
      expect(status).toBe(0);
      const lines = stdout.trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      // Each line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        const obj = JSON.parse(line) as { agent_id: string };
        expect(obj.agent_id).toBe('agent-1');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── agentw agent status — no DB ───────────────────────────────────────────────

describe('agentw agent status', () => {
  it('GATE: exits 0 with helpful message when DB does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      const { stdout, status } = cli(
        ['agent', 'status', '--db', path.join(tmpDir, 'missing.db')],
        {},
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout.toLowerCase()).toMatch(/no audit|no agents|not found/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shows event counts per agent when DB has data', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      const { AuditDb } = await import('../../../src/logger/audit.js');
      const dbPath = path.join(tmpDir, 'status.db');
      const db = new AuditDb(dbPath);
      db.log('dca-agent', 'pk1', 'agent_start', { strategy: 'dca' });
      db.log('dca-agent', 'pk1', 'tx_confirmed', { tick: 1 }, { signature: 's', status: 'confirmed' });
      db.log('dca-agent', 'pk1', 'agent_noop', { tick: 2 });
      db.close();

      const { stdout, status } = cli(
        ['agent', 'status', '--db', dbPath],
        {},
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('dca-agent');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Audit DB key-safety (CLI layer) ───────────────────────────────────────────

describe('Audit DB key-safety — CLI layer', () => {
  it('GATE: agent log --json output never contains key-adjacent field names', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-cli-test-'));
    try {
      const { AuditDb } = await import('../../../src/logger/audit.js');
      const dbPath = path.join(tmpDir, 'security.db');
      const db = new AuditDb(dbPath);

      // Try to insert details with forbidden fields — AuditDb.sanitiseDetails should strip them
      db.log('agent-1', 'pubkey1', 'agent_action', {
        tick: 1,
        secretKey: 'SHOULD_NOT_APPEAR',
        action: 'swap',
      });
      db.close();

      const { stdout } = cli(
        ['agent', 'log', '--db', dbPath, '--json'],
        {},
        tmpDir,
      );

      // The forbidden field should never appear in any output
      expect(stdout).not.toContain('SHOULD_NOT_APPEAR');
      expect(stdout).not.toContain('"secretKey"');
      expect(stdout).not.toContain('"privateKey"');
      expect(stdout).not.toContain('"keypair"');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
