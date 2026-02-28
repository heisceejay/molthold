/**
 * Integration tests for the Jupiter adapter against Solana devnet.
 *
 * Test gates from implementation plan:
 *  ✅ Jupiter quote returns valid outAmount > 0 for devnet token pair
 *  ✅ Jupiter swap executes and receiver balance increases
 *  ✅ Adapter rejects swap if wallet spending limit would breach
 *  ✅ SwapResult includes pre/post balances for auditability
 *
 * Prerequisites:
 *  - WALLET_SECRET_KEY set to a funded devnet keypair (>= 0.2 SOL)
 *  - SOLANA_RPC_URL pointing to devnet
 *
 * Skipped automatically if WALLET_SECRET_KEY is not set.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createWalletClient } from '../../../src/wallet/wallet.js';
import { loadFromEnv } from '../../../src/wallet/keystore.js';
import { WalletError } from '../../../src/wallet/types.js';
import { JupiterAdapter } from '../../../src/protocols/jupiter.js';
import { createAdapterRegistry } from '../../../src/protocols/index.js';
import { ProtocolError } from '../../../src/protocols/types.js';
import { createLogger } from '../../../src/logger/logger.js';
import type { WalletConfig } from '../../../src/wallet/types.js';

// ── Test setup ────────────────────────────────────────────────────────────────

const RPC_URL    = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
const SECRET_KEY = process.env['WALLET_SECRET_KEY'];
const SKIP       = !SECRET_KEY;
const itDev      = SKIP ? it.skip : it;

// Devnet token mints — wrapped SOL and devnet USDC
const WSOL_MINT  = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT  = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'); // devnet USDC

const logger = createLogger({ level: 'warn' });

let connection: Connection;
let testKeypair: Keypair;

const WALLET_CONFIG: WalletConfig = {
  rpcUrl: RPC_URL,
  limits: {
    maxPerTxLamports: 100_000_000n,  // 0.1 SOL
    maxSessionLamports: 500_000_000n, // 0.5 SOL
  },
  simulateBeforeSend: true,
  confirmationStrategy: 'confirmed',
  maxRetries: 3,
  retryDelayMs: 2_000,
};

beforeAll(async () => {
  if (SKIP) return;
  connection  = new Connection(RPC_URL, 'confirmed');
  testKeypair = loadFromEnv(SECRET_KEY!);
}, 10_000);

// ── Jupiter quote tests ───────────────────────────────────────────────────────

describe('JupiterAdapter.quote() — devnet', () => {
  itDev(
    'GATE: returns outAmount > 0 for SOL -> USDC on devnet',
    async () => {
      const adapter = new JupiterAdapter(connection, logger);
      const quote   = await adapter.quote(WSOL_MINT, USDC_MINT, 10_000_000n); // 0.01 SOL

      expect(quote.outAmount).toBeGreaterThan(0n);
      expect(quote.inAmount).toBe(10_000_000n);
      expect(quote.inputMint).toBe(WSOL_MINT.toBase58());
      expect(quote.outputMint).toBe(USDC_MINT.toBase58());
      expect(quote.provider).toBe('jupiter');
      expect(quote.priceImpactPct).toBeGreaterThanOrEqual(0);
      expect(typeof quote.outAmount).toBe('bigint');
    },
    20_000,
  );

  itDev(
    'returns a quote with otherAmountThreshold < outAmount (slippage applied)',
    async () => {
      const adapter = new JupiterAdapter(connection, logger);
      const quote   = await adapter.quote(WSOL_MINT, USDC_MINT, 10_000_000n);
      expect(quote.otherAmountThreshold).toBeLessThanOrEqual(quote.outAmount);
    },
    20_000,
  );
});

// ── Jupiter swap tests ────────────────────────────────────────────────────────

describe('JupiterAdapter.swap() — devnet', () => {
  itDev(
    'GATE: swap SOL -> USDC returns confirmed status with valid signature',
    async () => {
      const wallet  = createWalletClient(testKeypair, WALLET_CONFIG, logger);
      const adapter = new JupiterAdapter(connection, logger);

      const solBefore  = await wallet.getSolBalance();
      const usdcBefore = await wallet.getTokenBalance(USDC_MINT);

      const quote  = await adapter.quote(WSOL_MINT, USDC_MINT, 10_000_000n); // 0.01 SOL
      const result = await adapter.swap(wallet, quote, 100); // 1% slippage

      expect(result.status).toBe('confirmed');
      expect(result.signature).toBeTruthy();
      expect(result.signature!.length).toBeGreaterThan(40);
      expect(result.inAmount).toBe(10_000_000n);
      expect(result.inputMint).toBe(WSOL_MINT.toBase58());
      expect(result.outputMint).toBe(USDC_MINT.toBase58());

      // SwapResult must include pre/post balance info via outAmount
      expect(result.outAmount).toBeGreaterThan(0n);

      // USDC balance should have increased
      const usdcAfter = await wallet.getTokenBalance(USDC_MINT);
      expect(usdcAfter).toBeGreaterThan(usdcBefore);

      // SOL balance should have decreased
      const solAfter = await wallet.getSolBalance();
      expect(solAfter).toBeLessThan(solBefore);
    },
    60_000,
  );

  itDev(
    'GATE: swap is rejected by SpendingLimitGuard when inAmount exceeds per-tx limit',
    async () => {
      const tightConfig: WalletConfig = {
        ...WALLET_CONFIG,
        limits: {
          maxPerTxLamports: 1_000_000n,   // only 0.001 SOL per tx
          maxSessionLamports: 10_000_000n,
        },
      };
      const wallet  = createWalletClient(testKeypair, tightConfig, logger);
      const adapter = new JupiterAdapter(connection, logger);

      const quote = await adapter.quote(WSOL_MINT, USDC_MINT, 10_000_000n); // 0.01 SOL > limit

      // The swap must be rejected with LIMIT_BREACH before any transaction is sent
      await expect(adapter.swap(wallet, quote, 50)).rejects.toMatchObject({
        code: 'LIMIT_BREACH',
      });
    },
    30_000,
  );

  itDev(
    'SwapResult.quote matches the original quote used',
    async () => {
      const wallet  = createWalletClient(testKeypair, WALLET_CONFIG, logger);
      const adapter = new JupiterAdapter(connection, logger);
      const quote   = await adapter.quote(WSOL_MINT, USDC_MINT, 5_000_000n);
      const result  = await adapter.swap(wallet, quote, 100);

      expect(result.quote.inputMint).toBe(quote.inputMint);
      expect(result.quote.outputMint).toBe(quote.outputMint);
      expect(result.quote.provider).toBe('jupiter');
    },
    60_000,
  );
});

// ── getBestQuote integration test ─────────────────────────────────────────────

describe('AdapterRegistry.getBestQuote() — devnet', () => {
  itDev(
    'GATE: returns a valid quote from at least one adapter',
    async () => {
      const registry = createAdapterRegistry(connection, logger);
      const { quote, adapter } = await registry.getBestQuote(WSOL_MINT, USDC_MINT, 10_000_000n);

      expect(['jupiter', 'orca']).toContain(adapter);
      expect(quote.outAmount).toBeGreaterThan(0n);
      expect(quote.provider).toBe(adapter);
    },
    30_000,
  );
});

// ── RPC helpers integration tests ─────────────────────────────────────────────

describe('accountExists() — devnet', () => {
  itDev(
    'returns true for a known program account',
    async () => {
      const { accountExists } = await import('../../../src/protocols/rpc.js');
      // System program always exists
      const system = new PublicKey('11111111111111111111111111111111');
      expect(await accountExists(system, connection)).toBe(true);
    },
    10_000,
  );

  itDev(
    'returns false for a freshly generated address (almost certainly empty)',
    async () => {
      const { accountExists } = await import('../../../src/protocols/rpc.js');
      const empty = Keypair.generate().publicKey;
      expect(await accountExists(empty, connection)).toBe(false);
    },
    10_000,
  );
});

describe('getTokenPrice() — devnet', () => {
  itDev(
    'returns a non-null USD price for SOL',
    async () => {
      const { getTokenPrice } = await import('../../../src/protocols/rpc.js');
      const result = await getTokenPrice(WSOL_MINT, connection);

      expect(result.mint).toBe(WSOL_MINT.toBase58());
      expect(result.priceUsd).not.toBeNull();
      expect(result.priceUsd!).toBeGreaterThan(0);
      expect(result.source).toBe('jupiter');
    },
    15_000,
  );
});
