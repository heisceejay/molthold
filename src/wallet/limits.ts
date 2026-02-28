/**
 * @file src/wallet/limits.ts
 * SpendingLimitGuard — enforced before every transaction signing operation.
 *
 * This is the last software line of defence before lamports leave the wallet.
 * It runs synchronously (no async) so it cannot be bypassed by timing.
 */

import { WalletError, type SpendingLimits } from './types.js';

export class SpendingLimitGuard {
  private sessionSpendLamports = 0n;

  constructor(private readonly limits: SpendingLimits) {
    this.validateConfig();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Checks whether the proposed transaction is within all configured limits.
   * Throws WalletError('LIMIT_BREACH') synchronously if any limit is violated.
   *
   * @param estimatedLamports  Worst-case lamport spend for this transaction.
   *                           For swaps, use the `inAmount` from the quote.
   *                           For SOL transfers, use the exact amount.
   * @param destination        Optional base58 destination address. Checked
   *                           against allowedDestinations if that list is set.
   */
  check(estimatedLamports: bigint, destination?: string): void {
    // 1. Per-transaction limit
    if (estimatedLamports > this.limits.maxPerTxLamports) {
      throw new WalletError(
        'LIMIT_BREACH',
        `Transaction of ${estimatedLamports} lamports exceeds per-tx limit of ` +
          `${this.limits.maxPerTxLamports} lamports ` +
          `(${lamportsToSol(this.limits.maxPerTxLamports)} SOL).`,
      );
    }

    // 2. Session cumulative limit
    const projectedSessionSpend = this.sessionSpendLamports + estimatedLamports;
    if (projectedSessionSpend > this.limits.maxSessionLamports) {
      throw new WalletError(
        'LIMIT_BREACH',
        `Transaction would bring session spend to ${projectedSessionSpend} lamports, ` +
          `exceeding session cap of ${this.limits.maxSessionLamports} lamports ` +
          `(${lamportsToSol(this.limits.maxSessionLamports)} SOL). ` +
          `Current session spend: ${lamportsToSol(this.sessionSpendLamports)} SOL.`,
      );
    }

    // 3. Destination allowlist (if configured)
    if (this.limits.allowedDestinations !== undefined) {
      if (!destination) {
        throw new WalletError(
          'LIMIT_BREACH',
          'Destination allowlist is configured but no destination address was provided.',
        );
      }
      if (!this.limits.allowedDestinations.includes(destination)) {
        throw new WalletError(
          'LIMIT_BREACH',
          `Destination ${destination} is not in the allowed destinations list.`,
        );
      }
    }
  }

  /**
   * Records the actual lamport spend after a transaction confirms.
   * Call this only after `status === 'confirmed'`.
   */
  record(actualLamports: bigint): void {
    if (actualLamports < 0n) {
      throw new WalletError('INVALID_CONFIG', 'Cannot record negative lamport spend.');
    }
    this.sessionSpendLamports += actualLamports;
  }

  /** Returns current session spend in lamports. */
  getSessionSpend(): bigint {
    return this.sessionSpendLamports;
  }

  /** Returns remaining session budget in lamports. */
  getRemainingBudget(): bigint {
    return this.limits.maxSessionLamports - this.sessionSpendLamports;
  }

  /**
   * Resets the session spend counter.
   * Exposed for testing only. Do not call in production agent code.
   */
  reset(): void {
    this.sessionSpendLamports = 0n;
  }

  getStatus(): {
    sessionSpend: bigint;
    sessionCap: bigint;
    perTxCap: bigint;
    remainingBudget: bigint;
  } {
    return {
      sessionSpend: this.sessionSpendLamports,
      sessionCap: this.limits.maxSessionLamports,
      perTxCap: this.limits.maxPerTxLamports,
      remainingBudget: this.getRemainingBudget(),
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private validateConfig(): void {
    if (this.limits.maxPerTxLamports <= 0n) {
      throw new WalletError('INVALID_CONFIG', 'maxPerTxLamports must be greater than 0.');
    }
    if (this.limits.maxSessionLamports <= 0n) {
      throw new WalletError('INVALID_CONFIG', 'maxSessionLamports must be greater than 0.');
    }
    if (this.limits.maxPerTxLamports > this.limits.maxSessionLamports) {
      throw new WalletError(
        'INVALID_CONFIG',
        'maxPerTxLamports cannot exceed maxSessionLamports.',
      );
    }
    if (this.limits.allowedDestinations?.length === 0) {
      throw new WalletError(
        'INVALID_CONFIG',
        'allowedDestinations is an empty array. Set to undefined to allow all, ' +
          'or provide at least one address.',
      );
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lamportsToSol(lamports: bigint): string {
  const sol = Number(lamports) / 1_000_000_000;
  return sol.toFixed(6);
}
