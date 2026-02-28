/**
 * @file src/logger/logger.ts
 * Structured JSON logger wrapping pino.
 * Key-adjacent field names are redacted at the transport level as a last-resort guard.
 */

import { pino } from 'pino';
import type { Logger as PinoLogger } from 'pino';

// ── Redacted field names ──────────────────────────────────────────────────────
// These field names will never appear in log output — their values are replaced
// with '[REDACTED]'. This is a defence-in-depth measure; the wallet module
// itself must never pass key material to the logger.
const REDACTED_PATHS = [
  'secretKey',
  'secret_key',
  'privateKey',
  'private_key',
  'keypair',
  'seed',
  'mnemonic',
  'keyMaterial',
  'key_material',
  '*.secretKey',
  '*.privateKey',
  '*.keypair',
  '*.seed',
];

// ── Public logger type ────────────────────────────────────────────────────────

export type Logger = PinoLogger;

// ── Factory ───────────────────────────────────────────────────────────────────

export interface LoggerOptions {
  level?: string;
  /** Persistent fields bound to every log line from this logger. */
  bindings?: Record<string, string>;
  /** Whether to pretty-print (dev only). Never use in production. */
  pretty?: boolean;
}

/**
 * Creates a structured logger. Call once at startup and pass the instance
 * through the dependency tree. Never create ad-hoc loggers in modules.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const { level = 'info', bindings = {}, pretty = false } = options;

  const transport =
    pretty && process.env['NODE_ENV'] !== 'production'
      ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
      : undefined;

  const base = pino(
    {
      level,
      redact: {
        paths: REDACTED_PATHS,
        censor: '[REDACTED]',
      },
      serializers: {
        // Prevent accidentally logging Error cause chains that might contain key material
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
      base: {
        pid: process.pid,
        ...bindings,
      },
    },
    transport,
  );

  return base;
}

/**
 * Creates a child logger bound to a specific agent instance.
 * Every log line emitted by the agent will include agentId and walletPubkey.
 */
export function createAgentLogger(
  parent: Logger,
  agentId: string,
  walletPubkey: string,
): Logger {
  return parent.child({ agentId, walletPubkey });
}

/** Singleton root logger — initialised lazily on first import. */
let _rootLogger: Logger | undefined;

export function getRootLogger(): Logger {
  if (!_rootLogger) {
    _rootLogger = createLogger({
      level: process.env['LOG_LEVEL'] ?? 'info',
    });
  }
  return _rootLogger;
}
