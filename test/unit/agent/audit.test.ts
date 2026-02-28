/**
 * Unit tests for src/logger/audit.ts
 *
 * Test gates:
 *  ✅ Audit DB details_json contains no key-adjacent strings
 *  ✅ sanitiseDetails strips all forbidden field names
 *  ✅ Round-trip: insert → query returns correct data
 *  ✅ count() returns correct row counts per agent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditDb, sanitiseDetails, assertNoKeyMaterial } from '../../../src/logger/audit.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDb(): { db: AuditDb; dbPath: string; cleanup: () => void } {
  const dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-audit-test-'));
  const dbPath = path.join(dir, 'audit.db');
  const db     = new AuditDb(dbPath);
  return {
    db,
    dbPath,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── sanitiseDetails ───────────────────────────────────────────────────────────

describe('sanitiseDetails()', () => {
  it('passes through safe fields unchanged', () => {
    const input = { action: 'swap', amount: '1000', tick: 5 };
    expect(sanitiseDetails(input)).toEqual(input);
  });

  it('GATE: strips "secretKey" field', () => {
    const input = { action: 'swap', secretKey: 'SUPER_SECRET' };
    const out   = sanitiseDetails(input);
    expect(out).not.toHaveProperty('secretKey');
    expect(out).toHaveProperty('action', 'swap');
  });

  it('GATE: strips "privateKey" field', () => {
    const input = { privateKey: 'abc123', amount: '500' };
    const out   = sanitiseDetails(input);
    expect(out).not.toHaveProperty('privateKey');
    expect(out).toHaveProperty('amount', '500');
  });

  it('GATE: strips "keypair" field', () => {
    expect(sanitiseDetails({ keypair: {}, tick: 1 })).not.toHaveProperty('keypair');
  });

  it('GATE: strips "seed" field', () => {
    expect(sanitiseDetails({ seed: 'seedbytes', ok: true })).not.toHaveProperty('seed');
  });

  it('GATE: strips case-insensitive variants (SECRETKEY, Secret_Key)', () => {
    expect(sanitiseDetails({ SECRETKEY: 'x' })).not.toHaveProperty('SECRETKEY');
    expect(sanitiseDetails({ Secret_Key: 'x' })).not.toHaveProperty('Secret_Key');
  });

  it('strips forbidden fields nested inside objects', () => {
    const input = { wallet: { secretKey: 'bad', publicKey: 'safe' } };
    const out   = sanitiseDetails(input) as { wallet: Record<string, unknown> };
    expect(out['wallet']).not.toHaveProperty('secretKey');
    expect(out['wallet']).toHaveProperty('publicKey', 'safe');
  });

  it('does not mutate the original object', () => {
    const original = { secretKey: 'secret', amount: '100' };
    sanitiseDetails(original);
    expect(original).toHaveProperty('secretKey', 'secret');
  });

  it('handles null and undefined values without throwing', () => {
    const input = { action: 'noop', value: null };
    expect(() => sanitiseDetails(input as Record<string, unknown>)).not.toThrow();
  });

  it('handles arrays of objects — strips forbidden fields from each element', () => {
    const input = { items: [{ secretKey: 'x', name: 'a' }, { name: 'b' }] };
    const out   = sanitiseDetails(input) as { items: Record<string, unknown>[] };
    expect(out['items']?.[0]).not.toHaveProperty('secretKey');
    expect(out['items']?.[0]).toHaveProperty('name', 'a');
    expect(out['items']?.[1]).toHaveProperty('name', 'b');
  });
});

// ── assertNoKeyMaterial ───────────────────────────────────────────────────────

describe('assertNoKeyMaterial()', () => {
  it('passes on clean JSON', () => {
    expect(() => assertNoKeyMaterial('{"action":"swap","amount":"1000"}')).not.toThrow();
  });

  it('throws if secretKey appears in JSON string', () => {
    expect(() => assertNoKeyMaterial('{"secretKey":"bad"}')).toThrow();
  });

  it('throws if privateKey appears in JSON string', () => {
    expect(() => assertNoKeyMaterial('{"privateKey":"bad"}')).toThrow();
  });
});

// ── AuditDb ───────────────────────────────────────────────────────────────────

describe('AuditDb — insert and query', () => {
  let db: AuditDb;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTmpDb();
    db      = t.db;
    cleanup = t.cleanup;
  });

  afterEach(() => cleanup());

  it('inserts a row and query() returns it', () => {
    db.log('agent-1', 'pubkey123', 'agent_action', { tick: 1, action: 'swap' }, { signature: 'sig123', status: 'confirmed' });
    const rows = db.query({ agentId: 'agent-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_id).toBe('agent-1');
    expect(rows[0]?.event).toBe('agent_action');
    expect(rows[0]?.signature).toBe('sig123');
    expect(rows[0]?.wallet_pk).toBe('pubkey123');
  });

  it('GATE: details_json in inserted row contains no key-adjacent strings', () => {
    // Attempt to insert details with forbidden fields — they should be stripped
    db.log('agent-1', 'pubkey123', 'agent_action', {
      tick: 1,
      secretKey: 'THIS_SHOULD_BE_STRIPPED',
      action: 'swap',
    });

    const rows = db.query({ agentId: 'agent-1' });
    expect(rows).toHaveLength(1);
    const detailsJson = rows[0]?.details_json ?? '';

    // Must not contain the forbidden value
    expect(detailsJson).not.toContain('THIS_SHOULD_BE_STRIPPED');
    // Must not contain the forbidden field name
    expect(detailsJson).not.toContain('secretKey');
    // Safe field must still be present
    expect(detailsJson).toContain('swap');

    // Explicitly run the security assertion
    expect(() => assertNoKeyMaterial(detailsJson)).not.toThrow();
  });

  it('count() returns correct row count per agent', () => {
    db.log('agent-1', 'pk1', 'agent_noop', { tick: 1 });
    db.log('agent-1', 'pk1', 'agent_noop', { tick: 2 });
    db.log('agent-2', 'pk2', 'agent_noop', { tick: 1 });

    expect(db.count('agent-1')).toBe(2);
    expect(db.count('agent-2')).toBe(1);
    expect(db.count()).toBe(3);
  });

  it('query() filters by event type', () => {
    db.log('agent-1', 'pk1', 'tx_confirmed', { tick: 1 }, { signature: 's1', status: 'confirmed' });
    db.log('agent-1', 'pk1', 'agent_noop',   { tick: 2 });
    db.log('agent-1', 'pk1', 'tx_confirmed', { tick: 3 }, { signature: 's2', status: 'confirmed' });

    const confirmed = db.query({ agentId: 'agent-1', event: 'tx_confirmed' });
    expect(confirmed).toHaveLength(2);
    expect(confirmed.every((r) => r.event === 'tx_confirmed')).toBe(true);
  });

  it('query() respects limit', () => {
    for (let i = 0; i < 10; i++) {
      db.log('agent-1', 'pk1', 'agent_noop', { tick: i });
    }
    const rows = db.query({ agentId: 'agent-1', limit: 3 });
    expect(rows).toHaveLength(3);
  });

  it('query() returns rows in descending timestamp order', () => {
    db.log('agent-1', 'pk1', 'agent_noop', { tick: 1 });
    db.log('agent-1', 'pk1', 'agent_noop', { tick: 2 });
    db.log('agent-1', 'pk1', 'agent_noop', { tick: 3 });

    const rows = db.query({ agentId: 'agent-1' });
    expect(rows.length).toBe(3);
    // IDs should be in descending order (most recent first)
    expect(rows[0]!.id).toBeGreaterThan(rows[1]!.id);
    expect(rows[1]!.id).toBeGreaterThan(rows[2]!.id);
  });

  it('summarise() returns correct per-agent event counts', () => {
    db.log('agent-1', 'pk1', 'agent_noop',   { tick: 1 });
    db.log('agent-1', 'pk1', 'tx_confirmed', { tick: 2 }, { signature: 's', status: 'confirmed' });
    db.log('agent-2', 'pk2', 'agent_noop',   { tick: 1 });

    const summary = db.summarise();
    const a1noops = summary.find((r) => r.agent_id === 'agent-1' && r.event === 'agent_noop');
    const a1txs   = summary.find((r) => r.agent_id === 'agent-1' && r.event === 'tx_confirmed');
    expect(a1noops?.count).toBe(1);
    expect(a1txs?.count).toBe(1);
  });

  it('close() prevents further writes', () => {
    db.close();
    expect(() => db.log('agent-1', 'pk', 'agent_noop', {})).toThrow(/after close/);
  });

  it('isClosed reflects closed state', () => {
    expect(db.isClosed).toBe(false);
    db.close();
    expect(db.isClosed).toBe(true);
  });
});
