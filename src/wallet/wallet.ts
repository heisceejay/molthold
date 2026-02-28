/**
 * @file src/wallet/wallet.ts
 *
 * The WalletClient factory. This is the heart of the key-isolation architecture.
 *
 * SECURITY INVARIANT: The `keypair` parameter is captured in the factory
 * function's closure. It is NEVER assigned to a property of the returned object,
 * NEVER logged, and NEVER passed to any external function. Protocol adapters
 * interact only through the `signTransaction` method, which calls the signing
 * primitive inside this closure.
 *
 * The returned object's toJSON() and toString() return the public key only,
 * so accidental serialisation (e.g. JSON.stringify(wallet)) is safe.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  TransactionMessage,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getMint,
  getAccount,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import { SpendingLimitGuard } from './limits.js';
import { sendAndConfirm } from './signer.js';
import {
  WalletError,
  type WalletClient,
  type WalletConfig,
  type TxResult,
} from './types.js';
import type { Logger } from '../logger/logger.js';

// ── Default config ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Omit<WalletConfig, 'rpcUrl' | 'limits'> = {
  simulateBeforeSend: true,
  confirmationStrategy: 'confirmed',
  maxRetries: 3,
  retryDelayMs: 1_000,
};

// ── Priority fee ──────────────────────────────────────────────────────────────
// Micro-lamports per compute unit. Increase for faster inclusion during congestion.
const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 1_000;

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Creates a WalletClient. The `keypair` is captured in closure and never
 * exposed through the returned interface.
 *
 * @param keypair Solana Keypair. The caller should not retain a reference.
 * @param config  Wallet configuration.
 * @param logger  Bound logger (should already include agentId if applicable).
 */
export function createWalletClient(
  keypair: Keypair,
  config: WalletConfig,
  logger: Logger,
): WalletClient {
  // ── Internal state (closure-scoped) ────────────────────────────────────────

  const mergedConfig: WalletConfig = { ...DEFAULT_CONFIG, ...config };

  // Block mainnet URLs
  const rpcStr = mergedConfig.rpcUrl.toLowerCase();
  if (rpcStr.includes('mainnet-beta') || rpcStr.includes('api.mainnet-beta.solana.com')) {
    throw new WalletError('INVALID_CONFIG', 'SOLANA_RPC_URL appears to be a mainnet endpoint. Mainnet is blocked in v1.');
  }

  const connection = new Connection(mergedConfig.rpcUrl, mergedConfig.confirmationStrategy);
  const guard = new SpendingLimitGuard(mergedConfig.limits);


  // The public key is safe to surface
  const publicKey = keypair.publicKey;

  logger.info({ pubkey: publicKey.toBase58() }, 'WalletClient initialised');

  // ── Private signing primitive (never leaves this scope) ───────────────────

  async function signTx<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    try {
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
        return tx;
      }
      tx.partialSign(keypair);
      return tx;
    } catch (err) {
      throw new WalletError('SIGNING_FAILED', 'Failed to sign transaction.', err);
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  async function buildVersionedTx(
    instructions: ReturnType<typeof SystemProgram.transfer>[],
    feePayer: PublicKey,
  ): Promise<VersionedTransaction> {
    const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    const message = new TransactionMessage({
      payerKey: feePayer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    return new VersionedTransaction(message);
  }

  // ── WalletClient implementation ────────────────────────────────────────────

  const client: WalletClient = {
    get publicKey(): PublicKey {
      return publicKey;
    },

    async getSolBalance(): Promise<bigint> {
      try {
        const lamports = await connection.getBalance(publicKey, 'confirmed');
        return BigInt(lamports);
      } catch (err) {
        throw new WalletError('RPC_ERROR', 'Failed to fetch SOL balance.', err);
      }
    },

    async getTokenBalance(mint: PublicKey): Promise<bigint> {
      try {
        const ata = await getAssociatedTokenAddress(mint, publicKey);
        const account = await getAccount(connection, ata, 'confirmed');
        return account.amount;
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError) {
          return 0n;
        }
        throw new WalletError('RPC_ERROR', 'Failed to fetch token balance.', err);
      }
    },

    async getOrCreateTokenAccount(mint: PublicKey): Promise<PublicKey> {
      const ata = await getAssociatedTokenAddress(mint, publicKey);

      try {
        await getAccount(connection, ata, 'confirmed');
        return ata;
      } catch (err) {
        if (!(err instanceof TokenAccountNotFoundError)) {
          throw new WalletError('RPC_ERROR', 'Failed to check token account.', err);
        }
      }

      // Account doesn't exist — create it
      logger.info({ mint: mint.toBase58(), ata: ata.toBase58() }, 'Creating associated token account');

      const createIx = createAssociatedTokenAccountInstruction(publicKey, ata, publicKey, mint);
      const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
      });

      const tx = await buildVersionedTx([priorityIx, createIx], publicKey);
      const result = await client.signAndSendTransaction(tx, 5_000n); // ~0.000005 SOL for rent
      if (result.status !== 'confirmed') {
        throw new WalletError(
          'RPC_ERROR',
          `Failed to create token account: ${result.error ?? result.status}`,
        );
      }

      return ata;
    },

    async sendSol(to: PublicKey, lamports: bigint): Promise<TxResult> {
      if (lamports <= 0n) {
        throw new WalletError('INVALID_CONFIG', 'lamports must be greater than 0.');
      }

      const balance = await client.getSolBalance();
      if (balance < lamports) {
        throw new WalletError(
          'INSUFFICIENT_FUNDS',
          `Insufficient SOL: have ${balance} lamports, need ${lamports}.`,
        );
      }

      const transferIx = SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: to,
        lamports: Number(lamports),
      });
      const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
      });

      const tx = await buildVersionedTx([priorityIx, transferIx], publicKey);
      return (client as any).signAndSendTransaction(tx, lamports, to.toBase58());
    },

    async sendToken(mint: PublicKey, to: PublicKey, amount: bigint): Promise<TxResult> {
      if (amount <= 0n) {
        throw new WalletError('INVALID_CONFIG', 'amount must be greater than 0.');
      }

      // Fetch mint decimals for TransferChecked
      let decimals: number;
      try {
        const mintInfo = await getMint(connection, mint, 'confirmed');
        decimals = mintInfo.decimals;
      } catch (err) {
        throw new WalletError('RPC_ERROR', 'Failed to fetch mint info.', err);
      }

      const fromAta = await client.getOrCreateTokenAccount(mint);
      const toAta = await getAssociatedTokenAddress(mint, to);

      // Ensure destination ATA exists
      let toAtaExists = false;
      try {
        await getAccount(connection, toAta, 'confirmed');
        toAtaExists = true;
      } catch (err) {
        if (!(err instanceof TokenAccountNotFoundError)) {
          throw new WalletError('RPC_ERROR', 'Failed to check destination token account.', err);
        }
      }

      const instructions = [];

      if (!toAtaExists) {
        instructions.push(
          createAssociatedTokenAccountInstruction(publicKey, toAta, to, mint),
        );
      }

      instructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
        }),
        createTransferCheckedInstruction(fromAta, mint, toAta, publicKey, amount, decimals),
      );

      const tx = await buildVersionedTx(instructions, publicKey);
      return client.signAndSendTransaction(tx);
    },

    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      return signTx(tx);
    },

    async signAndSendTransaction(
      tx: Transaction | VersionedTransaction,
      estimatedLamports: bigint = 0n,
      destination?: string,
    ): Promise<TxResult> {
      // Enforce spending limits before touching the keypair
      if (estimatedLamports > 0n) {
        guard.check(estimatedLamports, destination);
      }

      const result = await sendAndConfirm({
        connection,
        transaction: tx,
        signerFn: signTx,
        config: mergedConfig,
        logger,
      });

      // Record actual spend on confirmation
      if (result.status === 'confirmed' && estimatedLamports > 0n) {
        guard.record(estimatedLamports);
      }

      logger.info(
        {
          signature: result.signature,
          status: result.status,
          slot: result.slot,
          error: result.error,
        },
        'Transaction complete',
      );

      return result;
    },

    getSpendingLimitStatus() {
      const s = guard.getStatus();
      return {
        sessionSpend: s.sessionSpend,
        sessionCap: s.sessionCap,
        perTxCap: s.perTxCap,
      };
    },
  };

  // ── Key-safe serialisation ─────────────────────────────────────────────────
  // Override toJSON and toString so that JSON.stringify(wallet) or
  // template literals never accidentally dump key material.

  (client as any)['toJSON'] = (): string => publicKey.toBase58();
  (client as any)['toString'] = (): string => publicKey.toBase58();
  (client as any)[Symbol.for("nodejs.util.inspect.custom")] = ():
    string => `WalletClient(${publicKey.toBase58()})`;

  return client;
}

// ── Convenience factory: load from keystore ────────────────────────────────

export { createWalletClient as default };
