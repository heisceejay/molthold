/**
 * @file src/config/env.ts
 * Single source of truth for all environment-derived configuration.
 * Validates at import time — if a required variable is missing or malformed,
 * the process exits before doing anything else.
 */

import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const SOL_TO_LAMPORTS = 1_000_000_000n;

const envSchema = z.object({
  // ── Solana Network ──────────────────────────────────────────────────────────
  SOLANA_RPC_URL: z
    .string()
    .url('SOLANA_RPC_URL must be a valid URL')
    .default('https://api.devnet.solana.com'),

  SOLANA_NETWORK: z
    .enum(['devnet', 'testnet'], {
      errorMap: () => ({
        message: 'SOLANA_NETWORK must be "devnet" or "testnet". Mainnet is blocked.',
      }),
    })
    .default('devnet'),

  // ── Key Management ──────────────────────────────────────────────────────────
  WALLET_PASSWORD: z.string().min(8, 'WALLET_PASSWORD must be at least 8 characters').optional(),

  // Only available in non-production environments
  WALLET_SECRET_KEY: z.string().optional(),

  // ── Spending Limits ─────────────────────────────────────────────────────────
  MAX_PER_TX_SOL: z.coerce
    .number()
    .positive('MAX_PER_TX_SOL must be positive')
    .default(0.1),

  MAX_SESSION_SOL: z.coerce
    .number()
    .positive('MAX_SESSION_SOL must be positive')
    .default(1.0),

  // ── Logging ─────────────────────────────────────────────────────────────────
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),

  AUDIT_DB_PATH: z.string().default('./logs/audit.db'),

  // ── Agent ───────────────────────────────────────────────────────────────────
  AGENTS_CONFIG_PATH: z.string().default('./agents.json'),
  AGENT_INTERVAL_MS: z.coerce.number().positive().default(30_000),

  // ── Runtime ─────────────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
});

function parseEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Use process.stderr directly — logger isn't initialised yet
    process.stderr.write(
      `\n[agentic-wallet] Environment validation failed:\n${issues}\n\n` +
        `  Copy .env.example to .env and fill in the required values.\n\n`,
    );
    process.exit(1);
  }

  const env = result.data;

  // Block WALLET_SECRET_KEY in production
  if (env.NODE_ENV === 'production' && env.WALLET_SECRET_KEY) {
    process.stderr.write(
      '[agentic-wallet] WALLET_SECRET_KEY is not allowed in production. Use a keystore file.\n',
    );
    process.exit(1);
  }

  // Block mainnet URLs even if SOLANA_NETWORK is set correctly
  if (env.SOLANA_RPC_URL.includes('mainnet-beta')) {
    process.stderr.write(
      '[agentic-wallet] SOLANA_RPC_URL appears to be a mainnet endpoint. Mainnet is blocked in v1.\n',
    );
    process.exit(1);
  }

  return env;
}

export const env = parseEnv();

// ── Derived values ────────────────────────────────────────────────────────────

/** Spending limits in lamports, derived from SOL values in env. */
export const spendingLimits = {
  maxPerTxLamports: BigInt(Math.round(env.MAX_PER_TX_SOL * Number(SOL_TO_LAMPORTS))),
  maxSessionLamports: BigInt(Math.round(env.MAX_SESSION_SOL * Number(SOL_TO_LAMPORTS))),
} as const;

export type Env = z.infer<typeof envSchema>;
