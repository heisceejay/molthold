/**
 * @file src/protocols/jupiter.ts
 *
 * Jupiter v6 swap adapter — primary swap path for Molthold.
 *
 * Flow per swap:
 *   1. GET /v6/quote  → serialised Quote
 *   2. POST /v6/swap  → serialised VersionedTransaction (base64)
 *   3. wallet.signAndSendTransaction(tx, inAmount) → TxResult
 *   4. Fetch post-tx state → verify outAmount within slippage → SwapResult
 *
 * SECURITY: This adapter receives a WalletClient, never a Keypair.
 * It must not store, log, or pass the wallet object to any other module.
 */

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import {
  ProtocolError,
  type Quote,
  type SwapAdapter,
  type SwapResult,
} from './types.js';
import { safePublicKey } from '../utils.js';
import type { WalletClient } from '../wallet/types.js';
import type { Logger } from '../logger/logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';
const FETCH_TIMEOUT_MS = 15_000;

// ── Jupiter API response shapes ───────────────────────────────────────────────
// We only type the fields we actually use; the rest is `unknown`.

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [key: string]: unknown;
}

interface JupiterSwapResponse {
  swapTransaction: string; // base64-encoded VersionedTransaction
  lastValidBlockHeight: number;
  [key: string]: unknown;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class JupiterAdapter implements SwapAdapter {
  readonly name = 'jupiter' as const;

  constructor(
    private readonly connection: Connection,
    private readonly logger: Logger,
  ) { }

  // ── quote() ─────────────────────────────────────────────────────────────────

  async quote(input: PublicKey, output: PublicKey, amountIn: bigint): Promise<Quote> {
    const params = new URLSearchParams({
      inputMint: input.toBase58(),
      outputMint: output.toBase58(),
      amount: amountIn.toString(),
      slippageBps: '50', // 0.5% default; overridden at swap time
    });

    this.logger.debug({ inputMint: input.toBase58(), outputMint: output.toBase58(), amountIn: amountIn.toString() }, 'Jupiter: fetching quote');

    let raw: JupiterQuoteResponse;
    try {
      const resp = await fetchWithTimeout(`${JUPITER_QUOTE_API}?${params}`, FETCH_TIMEOUT_MS);
      if (!resp.ok) {
        const body = await resp.text();
        throw new ProtocolError('QUOTE_FAILED', `Jupiter quote API returned ${resp.status}: ${body}`);
      }
      raw = await resp.json() as JupiterQuoteResponse;
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      throw new ProtocolError('QUOTE_FAILED', 'Jupiter quote request failed', err);
    }

    const outAmount = BigInt(raw.outAmount);
    if (outAmount === 0n) {
      throw new ProtocolError('QUOTE_FAILED', `Jupiter returned outAmount=0 for ${input.toBase58()} -> ${output.toBase58()}`);
    }

    const quote: Quote = {
      inputMint: raw.inputMint,
      outputMint: raw.outputMint,
      inAmount: BigInt(raw.inAmount),
      outAmount,
      otherAmountThreshold: BigInt(raw.otherAmountThreshold),
      priceImpactPct: parseFloat(raw.priceImpactPct),
      provider: 'jupiter',
      raw,                    // kept for audit; never logged directly
    };

    this.logger.debug({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inAmount.toString(),
      outAmount: quote.outAmount.toString(),
      priceImpactPct: quote.priceImpactPct,
    }, 'Jupiter: quote received');

    return quote;
  }

  // ── swap() ──────────────────────────────────────────────────────────────────

  async swap(wallet: WalletClient, quote: Quote, slippageBps: number): Promise<SwapResult> {
    // Log only the public key — never the wallet object itself
    this.logger.info({
      walletPubkey: wallet.publicKey.toBase58(),
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inAmount.toString(),
      estimatedOut: quote.outAmount.toString(),
      slippageBps,
    }, 'Jupiter: executing swap');

    // 1. Re-fetch a quote with the exact slippage bps so the threshold is correct
    const liveQuote = await this.refreshQuoteWithSlippage(quote, slippageBps);

    // 2. Get serialised transaction from Jupiter Swap API
    let swapResp: JupiterSwapResponse;
    try {
      const body = JSON.stringify({
        quoteResponse: liveQuote.raw,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 1000,
      });

      const resp = await fetchWithTimeout(JUPITER_SWAP_API, FETCH_TIMEOUT_MS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new ProtocolError('SWAP_FAILED', `Jupiter swap API returned ${resp.status}: ${errBody}`);
      }
      swapResp = await resp.json() as JupiterSwapResponse;
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      throw new ProtocolError('SWAP_FAILED', 'Jupiter swap request failed', err);
    }

    // 3. Deserialise the VersionedTransaction
    let tx: VersionedTransaction;
    try {
      const buf = Buffer.from(swapResp.swapTransaction, 'base64');
      tx = VersionedTransaction.deserialize(buf);
    } catch (err) {
      throw new ProtocolError('SWAP_FAILED', 'Failed to deserialise Jupiter swap transaction', err);
    }

    // 4. Capture pre-swap output token balance for diff
    const outputMintPk = safePublicKey(liveQuote.outputMint);
    const preOutBalance = await this.getTokenBalance(wallet.publicKey, outputMintPk);

    // 5. Sign and send via wallet (SpendingLimitGuard fires here)
    const txResult = await wallet.signAndSendTransaction(tx, liveQuote.inAmount);

    if (txResult.status !== 'confirmed') {
      return {
        ...txResult,
        inputMint: liveQuote.inputMint,
        outputMint: liveQuote.outputMint,
        inAmount: liveQuote.inAmount,
        outAmount: 0n,
        quote: liveQuote,
      };
    }

    // 6. Capture post-swap balance and compute actual outAmount
    const postOutBalance = await this.getTokenBalance(wallet.publicKey, outputMintPk);
    const actualOut = postOutBalance > preOutBalance ? postOutBalance - preOutBalance : 0n;

    // 7. Verify slippage — actual must be >= otherAmountThreshold
    if (actualOut < liveQuote.otherAmountThreshold && actualOut > 0n) {
      this.logger.warn({
        actualOut: actualOut.toString(),
        threshold: liveQuote.otherAmountThreshold.toString(),
        signature: txResult.signature,
      }, 'Jupiter: actual outAmount below slippage threshold (swap still confirmed)');
    }

    this.logger.info({
      signature: txResult.signature,
      inputMint: liveQuote.inputMint,
      outputMint: liveQuote.outputMint,
      inAmount: liveQuote.inAmount.toString(),
      actualOut: actualOut.toString(),
    }, 'Jupiter: swap confirmed');

    return {
      ...txResult,
      inputMint: liveQuote.inputMint,
      outputMint: liveQuote.outputMint,
      inAmount: liveQuote.inAmount,
      outAmount: actualOut,
      quote: liveQuote,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Re-fetches the quote with the exact slippage bps for the swap call.
   * This avoids using a stale quote that may have been fetched earlier.
   */
  private async refreshQuoteWithSlippage(quote: Quote, slippageBps: number): Promise<Quote> {
    const params = new URLSearchParams({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      amount: quote.inAmount.toString(),
      slippageBps: slippageBps.toString(),
    });

    try {
      const resp = await fetchWithTimeout(`${JUPITER_QUOTE_API}?${params}`, FETCH_TIMEOUT_MS);
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const raw = await resp.json() as JupiterQuoteResponse;
      return {
        ...quote,
        outAmount: BigInt(raw.outAmount),
        otherAmountThreshold: BigInt(raw.otherAmountThreshold),
        priceImpactPct: parseFloat(raw.priceImpactPct),
        raw,
      };
    } catch {
      // If refresh fails, return original quote — swap API will enforce its own slippage
      this.logger.debug('Jupiter: quote refresh failed, using original quote');
      return quote;
    }
  }

  private async getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
    try {
      const { getAssociatedTokenAddress } = await import('@solana/spl-token');
      const ata = await getAssociatedTokenAddress(mint, owner);
      const account = await getAccount(this.connection, ata, 'confirmed');
      return account.amount;
    } catch {
      return 0n;
    }
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
