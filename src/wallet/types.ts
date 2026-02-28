/**
 * @file src/wallet/types.ts
 * Shared types, interfaces, and error classes for the wallet module.
 * All other modules import from here — never the reverse.
 */

import type { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

// ── Result Types ──────────────────────────────────────────────────────────────

/**
 * The result of any transaction submission attempt.
 * status === 'confirmed' is the only success state.
 */
export interface TxResult {
  /** Base58-encoded transaction signature, or null if submission never reached the network. */
  signature: string | null;
  status: 'confirmed' | 'failed' | 'timeout' | 'simulated';
  /** The slot this transaction was confirmed in. */
  slot?: number;
  /** Human-readable error description. Never contains key material. */
  error?: string;
  /** Compute units consumed, available after confirmation. */
  computeUnitsConsumed?: number;
}

// ── Configuration Types ───────────────────────────────────────────────────────

/**
 * Spending limits enforced by SpendingLimitGuard before every signing operation.
 * All values are in lamports (1 SOL = 1_000_000_000 lamports).
 */
export interface SpendingLimits {
  /** Maximum lamports in a single transaction. Checked pre-signing. */
  maxPerTxLamports: bigint;
  /** Maximum cumulative lamports spent this session. Resets on process restart. */
  maxSessionLamports: bigint;
  /**
   * If set, the wallet will only sign transactions destined for these addresses.
   * An empty array means no destinations are allowed (effectively freezes the wallet).
   * Undefined means all destinations are allowed.
   */
  allowedDestinations?: string[];
}

/**
 * Full configuration for a WalletClient instance.
 */
export interface WalletConfig {
  rpcUrl: string;
  limits: SpendingLimits;
  /** Simulate every transaction before broadcasting. Catches most failures cheaply. */
  simulateBeforeSend: boolean;
  /** Confirmation level to wait for before returning success. */
  confirmationStrategy: 'confirmed' | 'finalized';
  /** Maximum number of send+confirm attempts before returning 'timeout'. */
  maxRetries: number;
  /** Base delay in ms between retry attempts (doubles each retry). */
  retryDelayMs: number;
}

// ── WalletClient Interface ────────────────────────────────────────────────────

/**
 * The public API surface of a wallet. This is an interface, not a class.
 * The only way to obtain a WalletClient is via the createWalletClient() factory.
 *
 * SECURITY: The Keypair is held inside the factory closure and is inaccessible
 * through this interface. Protocol adapters receive only a signTransaction
 * callback — they never see the Keypair object.
 */
export interface WalletClient {
  /** The wallet's public key. Safe to log and share. */
  readonly publicKey: PublicKey;

  // ── Balance queries ────────────────────────────────────────────────────────
  getSolBalance(): Promise<bigint>;
  getTokenBalance(mint: PublicKey): Promise<bigint>;
  /** Gets the associated token account for the given mint, creating it if needed. */
  getOrCreateTokenAccount(mint: PublicKey): Promise<PublicKey>;

  // ── Transfers ──────────────────────────────────────────────────────────────
  sendSol(to: PublicKey, lamports: bigint): Promise<TxResult>;
  sendToken(mint: PublicKey, to: PublicKey, amount: bigint): Promise<TxResult>;

  // ── Signing (for protocol adapters) ───────────────────────────────────────
  /**
   * Signs a pre-built transaction. Used by protocol adapters.
   * SpendingLimitGuard is NOT checked here — use signAndSendTransaction for guarded sends.
   */
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;

  /**
   * Signs, submits, and confirms a transaction.
   * SpendingLimitGuard is checked before signing. Throws WalletError on limit breach.
   */
  signAndSendTransaction(
    tx: Transaction | VersionedTransaction,
    estimatedLamports?: bigint,
  ): Promise<TxResult>;

  // ── Introspection (no key material) ───────────────────────────────────────
  getSpendingLimitStatus(): {
    sessionSpend: bigint;
    sessionCap: bigint;
    perTxCap: bigint;
  };
}

// ── Error Classes ─────────────────────────────────────────────────────────────

export type WalletErrorCode =
  | 'LIMIT_BREACH'
  | 'SIMULATION_FAILED'
  | 'INSUFFICIENT_FUNDS'
  | 'RPC_ERROR'
  | 'INVALID_KEYSTORE'
  | 'SIGNING_FAILED'
  | 'MAINNET_BLOCKED'
  | 'INVALID_CONFIG';

/**
 * Typed error thrown by all wallet module operations.
 * Always includes a machine-readable `code` for programmatic handling.
 */
export class WalletError extends Error {
  override readonly name = 'WalletError';

  constructor(
    public readonly code: WalletErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, WalletError);
    }
  }
}

// ── Keystore Types ────────────────────────────────────────────────────────────

/**
 * On-disk format for an encrypted wallet keystore.
 * Version field allows future format migrations without breaking existing keystores.
 */
export interface KeystoreFile {
  version: 1;
  /** Base58-encoded public key. Stored plaintext for quick identification. */
  publicKey: string;
  encrypted: {
    /** AES-256-GCM ciphertext, hex-encoded. */
    ciphertext: string;
    /** 16-byte initialisation vector, hex-encoded. Fresh per keystore. */
    iv: string;
    /** 16-byte GCM authentication tag, hex-encoded. Detects tampering. */
    authTag: string;
    /** 32-byte scrypt salt, hex-encoded. Fresh per keystore. */
    salt: string;
    algorithm: 'aes-256-gcm';
    kdf: 'scrypt';
    kdfParams: {
      /** CPU/memory cost. Default 32768 (~200ms on modern hardware). */
      N: number;
      r: number;
      p: number;
    };
  };
}
