/**
 * @file src/protocols/orca.ts
 *
 * Orca Whirlpools direct swap adapter — secondary swap path for Molthold.
 *
 * Unlike the Jupiter adapter which calls an off-chain aggregator API, this
 * adapter interacts directly with the Whirlpool on-chain program. This is more
 * complex but educational: it demonstrates how to build and submit a program
 * instruction without a middleware API.
 *
 * NOTE: @orca-so/whirlpools-sdk is a peer dependency. If it is unavailable
 * (e.g. not installed), the adapter will throw ADAPTER_UNAVAILABLE on init.
 * The adapter registry falls back to Jupiter in that case.
 *
 * SECURITY: This adapter receives a WalletClient, never a Keypair.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { ProtocolError } from './types.js';
import { safePublicKey } from '../utils.js';
import type { Quote, SwapAdapter, SwapResult } from './types.js';
import type { WalletClient } from '../wallet/types.js';
import type { Logger } from '../logger/logger.js';
import BN from 'bn.js';
import { Percentage } from '@orca-so/common-sdk';

// ── Known Whirlpool pool addresses on devnet ──────────────────────────────────
// These are the canonical devnet pool addresses for Orca Whirlpools.
// For mainnet a different set of addresses would be used.

export const DEVNET_POOLS: Record<string, string> = {
  // SOL/USDC 0.05% fee tier (devnet)
  'SOL_USDC': 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ',
  // SOL/USDC 0.3% fee tier (devnet)
  'SOL_USDC_30': '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm',
};

// ── SDK lazy import ───────────────────────────────────────────────────────────
// We lazy-import the Orca SDK so the rest of the codebase doesn't fail to
// compile if the SDK is not installed. The adapter itself throws ADAPTER_UNAVAILABLE.

type WhirlpoolClient = import('@orca-so/whirlpools-sdk').WhirlpoolClient;
type WhirlpoolContext = import('@orca-so/whirlpools-sdk').WhirlpoolContext;

// ── Adapter ───────────────────────────────────────────────────────────────────

export class OrcaAdapter implements SwapAdapter {
  readonly name = 'orca' as const;
  private sdk: typeof import('@orca-so/whirlpools-sdk') | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly logger: Logger,
  ) { }

  // ── Initialise SDK (lazy) ────────────────────────────────────────────────────

  private async ensureSdk(): Promise<typeof import('@orca-so/whirlpools-sdk')> {
    if (this.sdk) return this.sdk;
    try {
      this.sdk = await import('@orca-so/whirlpools-sdk');
      return this.sdk;
    } catch {
      throw new ProtocolError(
        'ADAPTER_UNAVAILABLE',
        'Orca Whirlpools SDK not installed. Run: npm install @orca-so/whirlpools-sdk @orca-so/common-sdk',
      );
    }
  }

  private async buildContext(walletPubkey: PublicKey): Promise<{ ctx: WhirlpoolContext; client: WhirlpoolClient }> {
    const orca = await this.ensureSdk();

    // Build a minimal wallet adapter that exposes only the public key.
    // The actual signing will be done via our WalletClient later.
    const walletAdapter = {
      publicKey: walletPubkey,
      signTransaction: async <T>(tx: T) => tx,      // signing deferred to WalletClient
      signAllTransactions: async <T>(txs: T[]) => txs,
    };

    const ctx = orca.WhirlpoolContext.withProvider(
      // @ts-expect-error — Anchor Provider shape is compatible enough for devnet
      { connection: this.connection, wallet: walletAdapter, opts: {} },
      orca.ORCA_WHIRLPOOL_PROGRAM_ID,
    );

    const client = orca.buildWhirlpoolClient(ctx);
    return { ctx, client };
  }

  // ── Find best pool for a pair ─────────────────────────────────────────────

  private async findPool(
    input: PublicKey,
    output: PublicKey,
    orca: typeof import('@orca-so/whirlpools-sdk'),
    client: WhirlpoolClient,
  ): Promise<{ pool: Awaited<ReturnType<WhirlpoolClient['getPool']>>; aToB: boolean }> {
    // Try both orderings — Orca pools have a canonical (tokenA, tokenB) ordering
    const orderings: [PublicKey, PublicKey, boolean][] = [
      [input, output, true],
      [output, input, false],
    ];

    for (const [t1, t2, aToB] of orderings) {
      const tickSpacings = [1, 8, 64, 128];
      for (const tickSpacing of tickSpacings) {
        try {
          const addr = orca.PDAUtil.getWhirlpool(
            orca.ORCA_WHIRLPOOL_PROGRAM_ID,
            orca.ORCA_WHIRLPOOLS_CONFIG,
            t1,
            t2,
            tickSpacing,
          ).publicKey;
          const pool = await client.getPool(addr);
          if (pool) return { pool, aToB };
        } catch {
          // Pool not found for this fee tier, try next
        }
      }
    }

    throw new ProtocolError(
      'POOL_NOT_FOUND',
      `No Orca Whirlpool found for ${input.toBase58()} <-> ${output.toBase58()} on devnet`,
    );
  }

  // ── quote() ─────────────────────────────────────────────────────────────────

  async quote(input: PublicKey, output: PublicKey, amountIn: bigint): Promise<Quote> {
    const orca = await this.ensureSdk();
    const { client } = await this.buildContext(input); // pubkey only needed here

    this.logger.debug({ inputMint: input.toBase58(), outputMint: output.toBase58(), amountIn: amountIn.toString() }, 'Orca: fetching quote');

    const { pool, aToB } = await this.findPool(input, output, orca, client);
    const poolData = pool.getData();

    const swapQuote = await orca.swapQuoteByInputToken(
      pool,
      input,
      new BN(amountIn.toString()),
      Percentage.fromFraction(50, 10_000), // 0.5% slippage for quote
      orca.ORCA_WHIRLPOOL_PROGRAM_ID,
      // @ts-expect-error — fetcher param optional
      undefined,
    );

    const outAmount = BigInt(swapQuote.estimatedAmountOut.toString());
    if (outAmount === 0n) {
      throw new ProtocolError('QUOTE_FAILED', `Orca returned estimatedAmountOut=0`);
    }

    const quote: Quote = {
      inputMint: input.toBase58(),
      outputMint: output.toBase58(),
      inAmount: amountIn,
      outAmount,
      otherAmountThreshold: BigInt(swapQuote.otherAmountThreshold.toString()),
      priceImpactPct: parseFloat(swapQuote.estimatedEndSqrtPrice.toString()) / 1e10, // approximate
      provider: 'orca',
      raw: { swapQuote, aToB, poolAddress: pool.getAddress().toBase58(), poolData },
    };

    this.logger.debug({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      outAmount: outAmount.toString(),
    }, 'Orca: quote received');

    return quote;
  }

  // ── swap() ──────────────────────────────────────────────────────────────────

  async swap(wallet: WalletClient, quote: Quote, slippageBps: number): Promise<SwapResult> {
    const orca = await this.ensureSdk();
    const { client } = await this.buildContext(wallet.publicKey);

    this.logger.info({
      walletPubkey: wallet.publicKey.toBase58(), // safe — pubkey only
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inAmount.toString(),
      slippageBps,
    }, 'Orca: executing swap');

    const input = safePublicKey(quote.inputMint);
    const output = safePublicKey(quote.outputMint);
    const { pool, aToB } = await this.findPool(input, output, orca, client);

    // Fetch a fresh quote at the actual slippage
    const swapQuote = await orca.swapQuoteByInputToken(
      pool,
      input,
      new BN(quote.inAmount.toString()),
      Percentage.fromFraction(slippageBps, 10_000),
      orca.ORCA_WHIRLPOOL_PROGRAM_ID,
      // @ts-expect-error
      undefined,
    );

    // Build the swap transaction
    const swapTxBuilder = await pool.swap(swapQuote);
    const transaction = await swapTxBuilder.build();

    // Convert to the format our WalletClient accepts
    // Orca uses the legacy Transaction type; set feePayer and blockhash
    (transaction as any).feePayer = wallet.publicKey;
    (transaction as any).recentBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;

    const preOutBalance = await wallet.getTokenBalance(output);
    const txResult = await wallet.signAndSendTransaction(transaction as any, quote.inAmount);

    if (txResult.status !== 'confirmed') {
      return {
        ...txResult,
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmount: quote.inAmount,
        outAmount: 0n,
        quote,
      };
    }

    const postOutBalance = await wallet.getTokenBalance(output);
    const actualOut = postOutBalance > preOutBalance ? postOutBalance - preOutBalance : 0n;

    this.logger.info({
      signature: txResult.signature,
      actualOut: actualOut.toString(),
    }, 'Orca: swap confirmed');

    return {
      ...txResult,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inAmount,
      outAmount: actualOut,
      quote,
    };
  }
}
