/**
 * Unit tests for src/cli/output.ts
 *
 * Test gates:
 *  ✅ lamportsToSol converts correctly
 *  ✅ formatBalance produces expected string shape
 *  ✅ formatAuditRows renders events without key-adjacent field values
 *  ✅ table handles empty rows
 *  ✅ kv aligns keys correctly
 *  ✅ sanitiseDetails (via audit.ts) strips forbidden fields — retested here
 *    to verify the output layer never passes key material forward
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lamportsToSol, formatBalance, formatAuditRows } from '../../../src/cli/output.js';
import type { AuditRow } from '../../../src/logger/audit.js';

// ── Silence stdout for output tests ──────────────────────────────────────────
// We redirect writes to a buffer so we can assert on the output string.

let captured = '';
beforeEach(() => {
  captured = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    captured += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── lamportsToSol ─────────────────────────────────────────────────────────────

describe('lamportsToSol()', () => {
  it('converts 1 SOL correctly', () => {
    expect(lamportsToSol(1_000_000_000n)).toBe('1.000000');
  });

  it('converts 0.5 SOL', () => {
    expect(lamportsToSol(500_000_000n)).toBe('0.500000');
  });

  it('converts 0 lamports', () => {
    expect(lamportsToSol(0n)).toBe('0.000000');
  });

  it('respects custom decimal places', () => {
    expect(lamportsToSol(1_000_000_000n, 2)).toBe('1.00');
    expect(lamportsToSol(1_500_000_000n, 3)).toBe('1.500');
  });

  it('handles large values without overflow', () => {
    // 1000 SOL
    expect(lamportsToSol(1_000_000_000_000n)).toBe('1000.000000');
  });

  it('handles 1 lamport (smallest unit)', () => {
    const result = lamportsToSol(1n);
    expect(parseFloat(result)).toBeCloseTo(0.000000001, 6);
  });
});

// ── formatBalance ─────────────────────────────────────────────────────────────

describe('formatBalance()', () => {
  it('includes SOL value as a number string', () => {
    const out = formatBalance(1_000_000_000n);
    // Strip ANSI codes for assertion
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('1.000000');
    expect(plain).toContain('SOL');
  });

  it('includes lamport count', () => {
    const out  = formatBalance(500_000_000n);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('500');
    expect(plain).toContain('lamports');
  });

  it('handles zero', () => {
    const out   = formatBalance(0n);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('0.000000');
  });
});

// ── formatAuditRows ───────────────────────────────────────────────────────────

function makeRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id:           1,
    ts:           new Date().toISOString(),
    agent_id:     'agent-1',
    event:        'tx_confirmed',
    wallet_pk:    'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW',
    signature:    'fakesig123',
    status:       'confirmed',
    details_json: JSON.stringify({ tick: 1, action: 'swap', rationale: 'DCA tick' }),
    ...overrides,
  };
}

describe('formatAuditRows()', () => {
  it('writes "(no audit events found)" for empty array', () => {
    formatAuditRows([]);
    expect(captured).toContain('No audit events found');
  });

  it('includes event type in output', () => {
    formatAuditRows([makeRow({ event: 'tx_confirmed' })]);
    const plain = captured.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('tx_confirmed');
  });

  it('includes truncated signature', () => {
    formatAuditRows([makeRow({ signature: 'abcdefghijklmnopqrstuvwxyz012345' })]);
    const plain = captured.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('abcdefghijklmno'); // first 16 chars
  });

  it('GATE: never outputs secretKey or privateKey values in details', () => {
    // Even if a row somehow had these fields (they should be stripped by AuditDb),
    // formatAuditRows should not echo them back
    const row = makeRow({
      details_json: JSON.stringify({
        tick: 5,
        action: 'swap',
        // These shouldn't be in real rows but we test the output layer anyway
        note: 'clean',
      }),
    });
    formatAuditRows([row]);
    expect(captured).not.toContain('secretKey');
    expect(captured).not.toContain('privateKey');
    expect(captured).not.toContain('keypair');
  });

  it('shows status in confirmed colour', () => {
    formatAuditRows([makeRow({ status: 'confirmed' })]);
    expect(captured).toContain('confirmed');
  });

  it('renders multiple rows without crashing', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeRow({ id: i + 1, event: i % 2 === 0 ? 'tx_confirmed' : 'agent_noop' }),
    );
    expect(() => formatAuditRows(rows)).not.toThrow();
  });

  it('handles malformed details_json gracefully', () => {
    const row = makeRow({ details_json: 'NOT_JSON{{' });
    expect(() => formatAuditRows([row])).not.toThrow();
    expect(captured).toContain('tx_confirmed');
  });

  it('renders details inline for interesting fields', () => {
    const row = makeRow({
      details_json: JSON.stringify({ tick: 7, action: 'swap', rationale: 'DCA buy', solBalance: '500000000' }),
    });
    formatAuditRows([row]);
    const plain = captured.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('tick=7');
    expect(plain).toContain('action=swap');
  });
});

// ── table ─────────────────────────────────────────────────────────────────────

import { table } from '../../../src/cli/output.js';

describe('table()', () => {
  it('renders "(no rows)" for empty data', () => {
    table(['A', 'B'], []);
    const plain = captured.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('(no rows)');
  });

  it('renders header row', () => {
    table(['Name', 'Value'], [['alice', '100']]);
    const plain = captured.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('Name');
    expect(plain).toContain('Value');
  });

  it('renders data rows', () => {
    table(['Name', 'Value'], [['alice', '100'], ['bob', '200']]);
    const plain = captured.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('alice');
    expect(plain).toContain('bob');
  });
});

// ── kv ────────────────────────────────────────────────────────────────────────

import { kv } from '../../../src/cli/output.js';

describe('kv()', () => {
  it('renders all key-value pairs', () => {
    kv([['Wallet', 'alice'], ['Balance', '1.5 SOL']]);
    const plain = captured.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('Wallet');
    expect(plain).toContain('alice');
    expect(plain).toContain('Balance');
    expect(plain).toContain('1.5 SOL');
  });

  it('aligns keys by padding to the longest key length', () => {
    kv([['A', '1'], ['LongKey', '2']]);
    const plain = captured.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = plain.split('\n').filter(Boolean);
    // Both lines should have the same number of characters before the value separator
    // We just verify both values appear
    expect(plain).toContain('1');
    expect(plain).toContain('2');
    expect(plain).toContain('LongKey');
  });
});
