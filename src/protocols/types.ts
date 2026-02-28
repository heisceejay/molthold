/**
 * @file src/protocols/types.ts
 * Shared types for the protocol adapter layer.
 */

import type { PublicKey } from '@solana/web3.js';
import type { TxResult, WalletClient } from '../wallet/types.js';

export interface Quote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  otherAmountThreshold: bigint;
  priceImpactPct: number;
  provider: AdapterName;
  raw: unknown;
}

export interface SwapResult extends TxResult {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  quote: Quote;
}

export interface PoolReserves {
  poolAddress: string;
  reserveA: bigint;
  reserveB: bigint;
  tokenMintA: string;
  tokenMintB: string;
  priceAtoB: number;
  fetchedAt: number;
}

export interface TokenPriceResult {
  mint: string;
  priceUsd: number | null;
  source: 'jupiter' | 'pyth' | 'unknown';
  fetchedAt: number;
}

export type AdapterName = 'jupiter' | 'orca';

export interface SwapAdapter {
  readonly name: AdapterName;
  quote(input: PublicKey, output: PublicKey, amountIn: bigint): Promise<Quote>;
  swap(wallet: WalletClient, quote: Quote, slippageBps: number): Promise<SwapResult>;
}

export interface AdapterRegistry {
  get(name: AdapterName): SwapAdapter;
  getBestQuote(
    input: PublicKey,
    output: PublicKey,
    amountIn: bigint,
  ): Promise<{ quote: Quote; adapter: AdapterName }>;
}

export type ProtocolErrorCode =
  | 'QUOTE_FAILED'
  | 'SWAP_FAILED'
  | 'SLIPPAGE_EXCEEDED'
  | 'POOL_NOT_FOUND'
  | 'ADAPTER_UNAVAILABLE'
  | 'PRICE_FETCH_FAILED'
  | 'INVALID_MINT';

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    if (Error.captureStackTrace) Error.captureStackTrace(this, ProtocolError);
  }
}
