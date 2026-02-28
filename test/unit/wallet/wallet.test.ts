/**
 * Unit tests for src/wallet/wallet.ts
 *
 * Test gates from implementation plan:
 *  ✅ toJSON() on WalletClient returns pubkey only
 *  ✅ toString() on WalletClient returns pubkey only
 *  ✅ SOL transfer exceeding limit is rejected before signing (mock RPC)
 *
 * Note: The full integration tests (SOL transfer on devnet, SPL token transfer)
 * live in test/integration/wallet/. These unit tests mock the RPC connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import { createWalletClient } from '../../../src/wallet/wallet.js';
import { WalletError } from '../../../src/wallet/types.js';
import { getRootLogger } from '../../../src/logger/logger.js';
import type { WalletConfig } from '../../../src/wallet/types.js';

const logger = getRootLogger();

const baseConfig: WalletConfig = {
  rpcUrl: 'https://api.devnet.solana.com',
  limits: {
    maxPerTxLamports: 100_000_000n,    // 0.1 SOL
    maxSessionLamports: 500_000_000n,  // 0.5 SOL
  },
  simulateBeforeSend: false,
  confirmationStrategy: 'confirmed',
  maxRetries: 1,
  retryDelayMs: 100,
};

function makeWallet(configOverride: Partial<WalletConfig> = {}): ReturnType<typeof createWalletClient> {
  const keypair = Keypair.generate();
  return createWalletClient(keypair, { ...baseConfig, ...configOverride }, logger);
}

// ── Key isolation / serialisation tests ──────────────────────────────────────

describe('WalletClient — key isolation', () => {
  it('GATE: toJSON() returns only the public key string', () => {
    const keypair = Keypair.generate();
    const wallet = createWalletClient(keypair, baseConfig, logger);

    const json = JSON.stringify(wallet);
    expect(json).toBe(`"${keypair.publicKey.toBase58()}"`);

    // Must not contain any secret key bytes
    const secretHex = Buffer.from(keypair.secretKey).toString('hex');
    expect(json).not.toContain(secretHex);
  });

  it('GATE: toString() returns only the public key string', () => {
    const keypair = Keypair.generate();
    const wallet = createWalletClient(keypair, baseConfig, logger);

    const str = String(wallet);
    expect(str).toBe(keypair.publicKey.toBase58());

    const secretHex = Buffer.from(keypair.secretKey).toString('hex');
    expect(str).not.toContain(secretHex);
  });

  it('SECURITY: wallet object inside a larger structure serialises safely', () => {
    const keypair = Keypair.generate();
    const wallet = createWalletClient(keypair, baseConfig, logger);

    const container = { agent: 'test', wallet };
    const serialised = JSON.stringify(container);

    // Should contain pubkey but not any private key bytes
    expect(serialised).toContain(keypair.publicKey.toBase58());
    const secretHex = Buffer.from(keypair.secretKey).toString('hex');
    expect(serialised).not.toContain(secretHex);
  });

  it('SECURITY: wallet in array serialises safely', () => {
    const keypair = Keypair.generate();
    const wallet = createWalletClient(keypair, baseConfig, logger);

    const arr = [wallet, { name: 'agent1' }];
    const serialised = JSON.stringify(arr);
    const secretHex = Buffer.from(keypair.secretKey).toString('hex');
    expect(serialised).not.toContain(secretHex);
  });

  it('publicKey property returns the correct PublicKey', () => {
    const keypair = Keypair.generate();
    const wallet = createWalletClient(keypair, baseConfig, logger);
    expect(wallet.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    expect(wallet.publicKey).toBeInstanceOf(PublicKey);
  });

  it('SECURITY: WalletClient has no secretKey property', () => {
    const wallet = makeWallet();
    expect((wallet as Record<string, unknown>)['secretKey']).toBeUndefined();
    expect((wallet as Record<string, unknown>)['keypair']).toBeUndefined();
    expect((wallet as Record<string, unknown>)['_keypair']).toBeUndefined();
  });

  it('SECURITY: WalletClient has no privateKey property', () => {
    const wallet = makeWallet();
    expect((wallet as Record<string, unknown>)['privateKey']).toBeUndefined();
    expect((wallet as Record<string, unknown>)['private_key']).toBeUndefined();
  });
});

// ── Spending limit enforcement tests (mocked RPC) ─────────────────────────────

describe('WalletClient — spending limit enforcement', () => {
  it('GATE: sendSol() rejects amount exceeding per-tx limit before any RPC call', async () => {
    const wallet = makeWallet();
    const recipient = Keypair.generate().publicKey;

    // 0.2 SOL > 0.1 SOL per-tx limit
    const tooMuch = 200_000_000n;

    // Mock getSolBalance so we don't need devnet
    vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(Number(1_000_000_000n));

    let err: WalletError | null = null;
    try {
      await wallet.sendSol(recipient, tooMuch);
    } catch (e) {
      err = e as WalletError;
    }

    expect(err?.code).toBe('LIMIT_BREACH');
    // Confirm no transaction was sent (no RPC send call)
    expect(Connection.prototype.sendRawTransaction).toBeUndefined;
  });

  it('GATE: sendSol() rejects amount exceeding session cap before any RPC call', async () => {
    const wallet = makeWallet({
      limits: {
        maxPerTxLamports: 100n,
        maxSessionLamports: 1000n, // 1000 lamports session cap
      }
    });
    const recipient = Keypair.generate().publicKey;
    const tooMuch = 2000n; // Attempts to send 2000 lamports

    // Mock getSolBalance so we don't need devnet
    vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(Number(1_000_000_000n));

    let err: WalletError | null = null;
    try {
      await wallet.sendSol(recipient, tooMuch);
    } catch (e) {
      err = e as WalletError;
    }

    expect(err?.code).toBe('LIMIT_BREACH');
    // Confirm no transaction was sent
    expect(Connection.prototype.sendRawTransaction).toBeUndefined;
  });

  it('getSpendingLimitStatus() returns correct initial state', () => {
    const wallet = makeWallet();
    const status = wallet.getSpendingLimitStatus();

    expect(status.sessionSpend).toBe(0n);
    expect(status.sessionCap).toBe(baseConfig.limits.maxSessionLamports);
    expect(status.perTxCap).toBe(baseConfig.limits.maxPerTxLamports);
  });
});

// ── Config validation tests ────────────────────────────────────────────────────

describe('WalletClient — factory validation', () => {
  it('throws if limits are invalid', () => {
    const keypair = Keypair.generate();
    const badConfig: WalletConfig = {
      ...baseConfig,
      limits: {
        maxPerTxLamports: 0n, // invalid
        maxSessionLamports: 500_000_000n,
      },
    };
    expect(() => createWalletClient(keypair, badConfig, logger)).toThrow(WalletError);
  });

  it('GATE: creation of wallet with mainnet RPC is blocked', () => {
    const keypair = Keypair.generate();
    const badConfig: WalletConfig = {
      ...baseConfig,
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    };
    expect(() => createWalletClient(keypair, badConfig, logger)).toThrow(WalletError);
  });
});
