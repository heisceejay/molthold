/**
 * @file src/wallet/signer.ts
 * Low-level transaction submission and confirmation with retry/backoff.
 *
 * Handles the realities of Solana RPC:
 *  - BlockhashNotFound: fetch fresh blockhash and resend
 *  - Network errors: exponential backoff, up to maxRetries
 *  - Confirmation timeout: return 'timeout' cleanly, do not throw
 *  - Transaction failures (program errors): return 'failed', do not retry
 */

import {
  Connection,
  Transaction,
  VersionedTransaction,
  SendTransactionError,
  type Commitment,
  type BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import { WalletError, type TxResult, type WalletConfig } from './types.js';
import type { Logger } from '../logger/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type AnyTransaction = Transaction | VersionedTransaction;

interface SendAndConfirmOptions {
  connection: Connection;
  transaction: AnyTransaction;
  signerFn: (tx: AnyTransaction) => Promise<AnyTransaction>;
  config: WalletConfig;
  logger: Logger;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Signs, sends, and confirms a transaction with retry logic.
 * The `signerFn` callback performs the actual keypair signing inside the
 * wallet module closure — this function never sees the Keypair.
 */
export async function sendAndConfirm(opts: SendAndConfirmOptions): Promise<TxResult> {
  const { connection, config, logger } = opts;
  let transaction = opts.transaction;
  let lastError: unknown;

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = config.retryDelayMs * 2 ** (attempt - 1);
      logger.debug({ attempt, delayMs: delay }, 'Retrying transaction');
      await sleep(delay);
    }

    try {
      // Fetch fresh blockhash on each attempt (handles BlockhashNotFound)
      let blockhashInfo: BlockhashWithExpiryBlockHeight;
      try {
        blockhashInfo = await connection.getLatestBlockhash(
          config.confirmationStrategy as Commitment,
        );
      } catch (err) {
        lastError = err;
        logger.warn({ err, attempt }, 'Failed to fetch blockhash');
        continue; // retry
      }

      // Set blockhash on transaction
      transaction = setBlockhash(transaction, blockhashInfo.blockhash);

      // Sign
      let signed: AnyTransaction;
      try {
        signed = await opts.signerFn(transaction);
      } catch (err) {
        throw new WalletError('SIGNING_FAILED', 'Transaction signing failed.', err);
      }

      // Simulate if configured
      if (config.simulateBeforeSend) {
        const simResult = await simulate(connection, signed, logger);
        if (simResult !== null) {
          return simResult;
        }
      }

      // Send
      const rawTx = serialise(signed);
      let signature: string;
      try {
        signature = await connection.sendRawTransaction(rawTx, {
          skipPreflight: config.simulateBeforeSend, // already simulated
          preflightCommitment: config.confirmationStrategy as Commitment,
          maxRetries: 0, // we handle retries ourselves
        });
      } catch (err) {
        if (isBlockhashExpired(err)) {
          lastError = err;
          logger.debug({ attempt }, 'Blockhash expired, will retry with fresh blockhash');
          continue;
        }
        if (isTransactionError(err)) {
          // Program error — don't retry
          return {
            signature: null,
            status: 'failed',
            error: extractErrorMessage(err),
          };
        }
        lastError = err;
        logger.warn({ err, attempt }, 'Transaction send failed');
        continue;
      }

      logger.debug({ signature, attempt }, 'Transaction sent, confirming…');

      // Confirm
      const confirmed = await confirmWithTimeout(
        connection,
        signature,
        blockhashInfo,
        config.confirmationStrategy as Commitment,
        60_000,
        logger,
      );

      return confirmed;
    } catch (err) {
      if (err instanceof WalletError) throw err; // propagate our own errors
      lastError = err;
      logger.warn({ err, attempt }, 'Unexpected error in send attempt');
    }
  }

  // Exhausted retries
  return {
    signature: null,
    status: 'timeout',
    error: `Exhausted ${config.maxRetries} attempts. Last error: ${String(lastError)}`,
  };
}

// ── Simulation ────────────────────────────────────────────────────────────────

/**
 * Simulates a transaction. Returns a TxResult if simulation fails (caller should
 * return it), or null if simulation passed (caller should proceed to send).
 */
async function simulate(
  connection: Connection,
  tx: AnyTransaction,
  logger: Logger,
): Promise<TxResult | null> {
  try {
    let simResponse;
    if (tx instanceof VersionedTransaction) {
      simResponse = await connection.simulateTransaction(tx as any, {
        commitment: 'confirmed',
      });
    } else {
      simResponse = await connection.simulateTransaction(tx as any);
    }

    if (simResponse.value.err) {
      const errStr = JSON.stringify(simResponse.value.err);
      logger.warn({ simError: errStr }, 'Transaction simulation failed');
      const result: TxResult = {
        signature: null,
        status: 'simulated',
        error: `Simulation failed: ${errStr}`
      };
      if (typeof simResponse.value.unitsConsumed === 'number') {
        result.computeUnitsConsumed = simResponse.value.unitsConsumed;
      }
      return result;
    }

    logger.debug(
      { units: simResponse.value.unitsConsumed },
      'Transaction simulation passed',
    );
    return null;
  } catch (err) {
    // Simulation RPC error — log but don't block the send
    logger.warn({ err }, 'Simulation RPC call failed, proceeding without simulation');
    return null;
  }
}

// ── Confirmation ──────────────────────────────────────────────────────────────

async function confirmWithTimeout(
  connection: Connection,
  signature: string,
  blockhashInfo: BlockhashWithExpiryBlockHeight,
  commitment: Commitment,
  timeoutMs: number,
  logger: Logger,
): Promise<TxResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(2_000);

    try {
      const statuses = await connection.getSignatureStatuses([signature]);
      const status = statuses.value[0];

      if (!status) continue; // Not yet visible on this RPC node

      if (status.err) {
        return {
          signature,
          status: 'failed',
          slot: status.slot,
          error: JSON.stringify(status.err),
        };
      }

      const confirmations = status.confirmationStatus;
      if (
        confirmations === 'finalized' ||
        (commitment === 'confirmed' && ((confirmations as any) === 'confirmed' || (confirmations as any) === 'finalized'))
      ) {
        // Fetch compute units consumed if available
        let cu: number | undefined;
        try {
          const txDetail = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          cu = txDetail?.meta?.computeUnitsConsumed ?? undefined;
        } catch {
          // Non-fatal — CU data is informational
        }

        logger.info({ signature, slot: status.slot, computeUnits: cu }, 'Transaction confirmed');

        const result: TxResult = {
          signature,
          status: 'confirmed',
          slot: status.slot,
        };
        if (typeof cu === 'number') result.computeUnitsConsumed = cu;
        return result;
      }
    } catch (err) {
      logger.debug({ err, signature }, 'getSignatureStatuses error, will retry');
    }
  }

  return {
    signature,
    status: 'timeout',
    error: `Transaction ${signature} not confirmed within ${timeoutMs}ms`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setBlockhash(tx: AnyTransaction, blockhash: string): AnyTransaction {
  if (tx instanceof VersionedTransaction) {
    tx.message.recentBlockhash = blockhash;
    return tx;
  }
  tx.recentBlockhash = blockhash;
  return tx;
}

function serialise(tx: AnyTransaction): Buffer {
  if (tx instanceof VersionedTransaction) {
    return Buffer.from(tx.serialize());
  }
  return tx.serialize();
}

function isBlockhashExpired(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.message.includes('BlockhashNotFound') ||
      err.message.includes('Blockhash not found')
    );
  }
  return false;
}

function isTransactionError(err: unknown): boolean {
  return err instanceof SendTransactionError;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof SendTransactionError) {
    return err.message;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
