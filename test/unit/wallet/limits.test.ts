/**
 * Unit tests for src/wallet/limits.ts
 *
 * Test gates from implementation plan:
 *  ✅ SpendingLimitGuard: per-tx limit throws correctly
 *  ✅ SpendingLimitGuard: session cap throws after cumulative spend
 *  ✅ SpendingLimitGuard: allowedDestinations rejects unlisted address
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SpendingLimitGuard } from '../../../src/wallet/limits.js';
import { WalletError } from '../../../src/wallet/types.js';

const SOL = 1_000_000_000n; // 1 SOL in lamports

const baseConfig = {
  maxPerTxLamports: 100_000_000n,    // 0.1 SOL
  maxSessionLamports: 500_000_000n,  // 0.5 SOL
};

describe('SpendingLimitGuard — per-tx limit', () => {
  let guard: SpendingLimitGuard;

  beforeEach(() => {
    guard = new SpendingLimitGuard(baseConfig);
  });

  it('allows a transaction within the per-tx limit', () => {
    expect(() => guard.check(50_000_000n)).not.toThrow();
  });

  it('allows a transaction exactly at the per-tx limit', () => {
    expect(() => guard.check(100_000_000n)).not.toThrow();
  });

  it('GATE: throws LIMIT_BREACH when exceeding per-tx limit', () => {
    expect(() => guard.check(100_000_001n)).toThrow(WalletError);

    let err: WalletError | null = null;
    try {
      guard.check(100_000_001n);
    } catch (e) {
      err = e as WalletError;
    }
    expect(err?.code).toBe('LIMIT_BREACH');
    expect(err?.message).toContain('per-tx limit');
  });

  it('error message includes the limit value in SOL', () => {
    let err: WalletError | null = null;
    try {
      guard.check(SOL); // 1 SOL, way over limit
    } catch (e) {
      err = e as WalletError;
    }
    expect(err?.message).toContain('0.100000'); // 0.1 SOL limit
  });
});

describe('SpendingLimitGuard — session cap', () => {
  let guard: SpendingLimitGuard;

  beforeEach(() => {
    guard = new SpendingLimitGuard(baseConfig);
  });

  it('GATE: throws after cumulative spend hits session cap', () => {
    // Spend in 5 × 0.1 SOL increments = 0.5 SOL session cap
    guard.check(100_000_000n);
    guard.record(100_000_000n);
    guard.check(100_000_000n);
    guard.record(100_000_000n);
    guard.check(100_000_000n);
    guard.record(100_000_000n);
    guard.check(100_000_000n);
    guard.record(100_000_000n);

    // 4th check passed — 0.4 SOL spent so far. 5th would hit cap.
    expect(() => guard.check(100_000_001n)).toThrow(WalletError);
  });

  it('GATE: error code is LIMIT_BREACH for session cap violation', () => {
    guard.check(100_000_000n);
    guard.record(100_000_000n);
    guard.check(100_000_000n);
    guard.record(100_000_000n);
    guard.check(100_000_000n);
    guard.record(100_000_000n);
    guard.check(100_000_000n);
    guard.record(100_000_000n);
    guard.check(100_000_000n);
    guard.record(100_000_000n);

    // Session cap exhausted — next check must fail
    let err: WalletError | null = null;
    try {
      guard.check(1n);
    } catch (e) {
      err = e as WalletError;
    }
    expect(err?.code).toBe('LIMIT_BREACH');
    expect(err?.message).toContain('session cap');
  });

  it('tracks session spend correctly via getSessionSpend()', () => {
    guard.record(50_000_000n);
    guard.record(30_000_000n);
    expect(guard.getSessionSpend()).toBe(80_000_000n);
  });

  it('reset() clears the session spend counter', () => {
    guard.record(100_000_000n);
    guard.record(100_000_000n);
    expect(guard.getSessionSpend()).toBe(200_000_000n);

    guard.reset();
    expect(guard.getSessionSpend()).toBe(0n);
  });

  it('check does not increment session spend — only record() does', () => {
    guard.check(100_000_000n);
    guard.check(100_000_000n);
    guard.check(100_000_000n);
    // check() alone never records spend
    expect(guard.getSessionSpend()).toBe(0n);
  });
});

describe('SpendingLimitGuard — allowedDestinations', () => {
  const ALLOWED_ADDR = 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW';
  const OTHER_ADDR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  let guard: SpendingLimitGuard;

  beforeEach(() => {
    guard = new SpendingLimitGuard({
      ...baseConfig,
      allowedDestinations: [ALLOWED_ADDR],
    });
  });

  it('allows a transaction to an allowed destination', () => {
    expect(() => guard.check(1_000_000n, ALLOWED_ADDR)).not.toThrow();
  });

  it('GATE: rejects a transaction to an unlisted destination', () => {
    let err: WalletError | null = null;
    try {
      guard.check(1_000_000n, OTHER_ADDR);
    } catch (e) {
      err = e as WalletError;
    }
    expect(err?.code).toBe('LIMIT_BREACH');
    expect(err?.message).toContain('not in the allowed destinations');
    expect(err?.message).toContain(OTHER_ADDR);
  });

  it('throws if no destination provided when allowlist is configured', () => {
    let err: WalletError | null = null;
    try {
      guard.check(1_000_000n); // no destination
    } catch (e) {
      err = e as WalletError;
    }
    expect(err?.code).toBe('LIMIT_BREACH');
    expect(err?.message).toContain('no destination address was provided');
  });

  it('allows all destinations when allowedDestinations is undefined', () => {
    const openGuard = new SpendingLimitGuard(baseConfig); // no allowedDestinations
    expect(() => openGuard.check(1_000_000n, ALLOWED_ADDR)).not.toThrow();
    expect(() => openGuard.check(1_000_000n, OTHER_ADDR)).not.toThrow();
    expect(() => openGuard.check(1_000_000n)).not.toThrow();
  });

  it('supports multiple allowed destinations', () => {
    const multiGuard = new SpendingLimitGuard({
      ...baseConfig,
      allowedDestinations: [ALLOWED_ADDR, OTHER_ADDR],
    });
    expect(() => multiGuard.check(1_000_000n, ALLOWED_ADDR)).not.toThrow();
    expect(() => multiGuard.check(1_000_000n, OTHER_ADDR)).not.toThrow();
  });
});

describe('SpendingLimitGuard — configuration validation', () => {
  it('throws if maxPerTxLamports is zero', () => {
    expect(
      () => new SpendingLimitGuard({ maxPerTxLamports: 0n, maxSessionLamports: SOL }),
    ).toThrow(WalletError);
  });

  it('throws if maxSessionLamports is zero', () => {
    expect(
      () => new SpendingLimitGuard({ maxPerTxLamports: SOL, maxSessionLamports: 0n }),
    ).toThrow(WalletError);
  });

  it('throws if per-tx limit exceeds session limit', () => {
    expect(
      () => new SpendingLimitGuard({ maxPerTxLamports: 2n * SOL, maxSessionLamports: SOL }),
    ).toThrow(WalletError);
  });

  it('throws if allowedDestinations is an empty array', () => {
    expect(
      () => new SpendingLimitGuard({ ...baseConfig, allowedDestinations: [] }),
    ).toThrow(WalletError);
  });
});

describe('SpendingLimitGuard — getStatus()', () => {
  it('returns correct status snapshot', () => {
    const guard = new SpendingLimitGuard(baseConfig);
    guard.record(25_000_000n);

    const status = guard.getStatus();
    expect(status.sessionSpend).toBe(25_000_000n);
    expect(status.sessionCap).toBe(baseConfig.maxSessionLamports);
    expect(status.perTxCap).toBe(baseConfig.maxPerTxLamports);
    expect(status.remainingBudget).toBe(baseConfig.maxSessionLamports - 25_000_000n);
  });
});
