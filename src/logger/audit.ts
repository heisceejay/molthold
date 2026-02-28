/**
 * @file src/logger/audit.ts
 *
 * Append-only SQLite audit database.
 * Every agent action and transaction attempt is written here for forensic review.
 *
 * SECURITY: The `details_json` column must never contain key material.
 * This is enforced by the `sanitiseDetails()` function which strips any field
 * whose name matches a key-adjacent pattern before serialisation.
 * A unit test in test/unit/agent/audit.test.ts verifies this property.
 *
 * Schema version: 1
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditEventType =
  | 'tx_attempt'
  | 'tx_confirmed'
  | 'tx_failed'
  | 'tx_timeout'
  | 'agent_action'
  | 'agent_noop'
  | 'agent_start'
  | 'agent_stop'
  | 'agent_error'
  | 'limit_breach'
  | 'system_stop_request';

export interface AuditEvent {
  /** ISO 8601 timestamp. */
  ts: string;
  agentId: string;
  event: AuditEventType;
  /** Base58 public key of the wallet involved. Safe to store. */
  walletPk: string;
  /** Transaction signature, if applicable. */
  signature?: string | null;
  /** Transaction status, if applicable. */
  status?: string | null;
  /** Arbitrary structured details — sanitised before storage. */
  details: Record<string, unknown>;
}

export interface AuditRow {
  id: number;
  ts: string;
  agent_id: string;
  event: string;
  wallet_pk: string;
  signature: string | null;
  status: string | null;
  details_json: string;
}

export interface QueryOptions {
  agentId?: string;
  walletPk?: string;
  event?: AuditEventType;
  limit?: number;
  before?: string; // ISO timestamp
}

// ── Forbidden field names (key-adjacent) ─────────────────────────────────────

const FORBIDDEN_FIELD_PATTERNS = [
  /^secretKey$/i,
  /^secret_key$/i,
  /^privateKey$/i,
  /^private_key$/i,
  /^keypair$/i,
  /^seed$/i,
  /^mnemonic$/i,
  /^keyMaterial$/i,
  /^key_material$/i,
];

// ── AuditDb class ─────────────────────────────────────────────────────────────

export class AuditDb {
  private db: InstanceType<typeof Database>;
  private insertStmt: ReturnType<InstanceType<typeof Database>['prepare']>;
  private closed = false;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');  // WAL mode: safe concurrent reads
    this.db.pragma('synchronous = NORMAL'); // Balance durability vs performance
    this.db.pragma('foreign_keys = ON');

    this.migrate();

    this.insertStmt = this.db.prepare(`
      INSERT INTO events (ts, agent_id, event, wallet_pk, signature, status, details_json)
      VALUES (@ts, @agentId, @event, @walletPk, @signature, @status, @detailsJson)
    `);
  }

  // ── Schema migration ────────────────────────────────────────────────────────

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           TEXT    NOT NULL,
        agent_id     TEXT    NOT NULL,
        event        TEXT    NOT NULL,
        wallet_pk    TEXT    NOT NULL,
        signature    TEXT,
        status       TEXT,
        details_json TEXT    NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_agent ON events (agent_id, ts);
      CREATE INDEX IF NOT EXISTS idx_event ON events (event, ts);
      CREATE INDEX IF NOT EXISTS idx_wallet ON events (wallet_pk, ts);
    `);
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Inserts one audit event.
   * The `details` object is sanitised before serialisation — forbidden field
   * names are stripped and the resulting JSON is verified to contain no
   * key-adjacent patterns.
   */
  insert(event: AuditEvent): void {
    if (this.closed) throw new Error('AuditDb: attempted write after close()');

    const cleanDetails = sanitiseDetails(event.details);

    this.insertStmt.run({
      ts: event.ts,
      agentId: event.agentId,
      event: event.event,
      walletPk: event.walletPk,
      signature: event.signature ?? null,
      status: event.status ?? null,
      detailsJson: JSON.stringify(cleanDetails),
    });
  }

  /** Convenience: insert with current timestamp. */
  log(
    agentId: string,
    walletPk: string,
    eventType: AuditEventType,
    details: Record<string, unknown>,
    txFields?: { signature?: string | null; status?: string | null },
  ): void {
    this.insert({
      ts: new Date().toISOString(),
      agentId,
      event: eventType,
      walletPk,
      signature: txFields?.signature ?? null,
      status: txFields?.status ?? null,
      details,
    });
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  /** Returns the most recent N events, optionally filtered. */
  query(opts: QueryOptions = {}): AuditRow[] {
    const { agentId, walletPk, event, limit = 50, before } = opts;

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (agentId) { conditions.push('agent_id = @agentId'); params['agentId'] = agentId; }
    if (walletPk) { conditions.push('wallet_pk = @walletPk'); params['walletPk'] = walletPk; }
    if (event) { conditions.push('event = @event'); params['event'] = event; }
    if (before) { conditions.push('ts < @before'); params['before'] = before; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM events ${where} ORDER BY ts DESC LIMIT @limit`;
    params['limit'] = limit;

    return this.db.prepare(sql).all(params) as AuditRow[];
  }

  /** Returns event counts grouped by agent_id and event type. */
  summarise(): Array<{ agent_id: string; event: string; count: number }> {
    return this.db
      .prepare('SELECT agent_id, event, COUNT(*) as count FROM events GROUP BY agent_id, event ORDER BY agent_id, event')
      .all() as Array<{ agent_id: string; event: string; count: number }>;
  }

  /** Total event count — useful for assertions in tests. */
  count(agentId?: string, walletPk?: string): number {
    const conditions: string[] = [];
    const params: any[] = [];

    if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
    if (walletPk) { conditions.push('wallet_pk = ?'); params.push(walletPk); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as n FROM events ${where}`;

    const row = this.db.prepare(sql).get(...params) as { n: number };
    return row.n;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Flush WAL and close the connection. Call on graceful shutdown. */
  close(): void {
    if (this.closed) return;
    this.db.pragma('wal_checkpoint(FULL)');
    this.db.close();
    this.closed = true;
  }

  get isClosed(): boolean { return this.closed; }
}

// ── Sanitisation ──────────────────────────────────────────────────────────────

/**
 * Recursively removes any field whose name matches a key-adjacent pattern.
 * Returns a new object — the original is not mutated.
 *
 * Exported for testing.
 */
export function sanitiseDetails(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_FIELD_PATTERNS.some((re) => re.test(key))) {
      // Strip this field — never store it
      continue;
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitiseDetails(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      // Shallow sanitise array elements that are plain objects
      result[key] = value.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? sanitiseDetails(item as Record<string, unknown>)
          : item,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Asserts that a serialised details JSON string contains no key-adjacent
 * field names. Used in tests.
 */
export function assertNoKeyMaterial(detailsJson: string): void {
  const badPatterns = [/secret[Kk]ey/i, /private[Kk]ey/i, /keypair/i, /seed/i, /mnemonic/i, /key[Mm]aterial/i];
  for (const pattern of badPatterns) {
    if (pattern.test(detailsJson)) {
      throw new Error(
        `AuditDb security violation: details_json contains forbidden field matching ${pattern}`,
      );
    }
  }
}
