/**
 * @file src/agent/strategies/rebalancer.ts
 *
 * Rebalancer strategy.
 *
 * Maintains a target SOL/token portfolio ratio.
 * If the actual allocation drifts outside a configurable band, it swaps
 * to bring the portfolio back to target.
 *
 * Decision logic (decide):
 *   1. Compute portfolio value: solValue + tokenValue (using Jupiter price)
 *   2. Compute current SOL allocation %
 *   3. If |currentSolPct - targetSolPct| > bandPct → compute swap and return action
 *   4. Otherwise → noop
 *
 * Strategy params:
 *   targetMint     string   Mint of the token held alongside SOL
 *   targetSolPct   number   Target SOL % of portfolio (0–100)
 *   bandPct        number   Allowed drift before rebalancing triggers (e.g. 5 = ±5%)
 *   adapter        'jupiter' | 'orca' | 'best'
 *   slippageBps    number   Swap slippage in bps (default 100 = 1%)
 */

import { PublicKey } from '@solana/web3.js';
import { getTokenPrice } from '../../protocols/rpc.js';
import { Connection } from '@solana/web3.js';
import { ProtocolError } from '../../protocols/types.js';
import { safePublicKey } from '../../utils.js';
import type { AdapterRegistry } from '../../protocols/types.js';
import type { WalletClient, TxResult } from '../../wallet/types.js';
import type { Action, AgentState, Strategy } from '../types.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;

// ── Validated params ──────────────────────────────────────────────────────────

interface RebalancerParams {
  targetMint: string;
  targetSolPct: number;  // 0-100
  bandPct: number;   // e.g. 5 = ±5%
  adapter: 'jupiter' | 'orca' | 'best';
  slippageBps: number;
  rpcUrl: string;
}

function parseRebalancerParams(raw: Record<string, unknown>, rpcUrl: string): RebalancerParams {
  const targetMint = raw['targetMint'];
  if (typeof targetMint !== 'string' || !targetMint) {
    throw new Error('Rebalancer strategy: targetMint is required');
  }
  try { safePublicKey(targetMint); } catch {
    throw new Error(`[rebalancer] Invalid targetMint config: ${targetMint}`);
  }

  const targetSolPct = Number(raw['targetSolPct'] ?? 50);
  if (isNaN(targetSolPct) || targetSolPct < 0 || targetSolPct > 100) {
    throw new Error('Rebalancer strategy: targetSolPct must be 0–100');
  }

  const bandPct = Number(raw['bandPct'] ?? 5);
  if (isNaN(bandPct) || bandPct <= 0 || bandPct > 50) {
    throw new Error('Rebalancer strategy: bandPct must be between 0 and 50');
  }

  const rawAdapter = raw['adapter'] ?? 'best';
  if (!['jupiter', 'orca', 'best'].includes(String(rawAdapter))) {
    throw new Error(`Rebalancer strategy: adapter must be 'jupiter', 'orca', or 'best'`);
  }

  const slippageBps = Number(raw['slippageBps'] ?? 100);

  return {
    targetMint,
    targetSolPct,
    bandPct,
    adapter: rawAdapter as 'jupiter' | 'orca' | 'best',
    slippageBps,
    rpcUrl,
  };
}

// ── Strategy ──────────────────────────────────────────────────────────────────

export class RebalancerStrategy implements Strategy {
  readonly name = 'rebalancer' as const;
  private readonly params: RebalancerParams;
  private readonly connection: Connection;

  constructor(rawParams: Record<string, unknown>, rpcUrl: string) {
    this.params = parseRebalancerParams(rawParams, rpcUrl);
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  // ── decide() ────────────────────────────────────────────────────────────────

  async decide(state: AgentState): Promise<Action> {
    const { targetMint, targetSolPct, bandPct } = this.params;
    const targetMintPk = safePublicKey(targetMint);

    // Get current token balance
    const tokenBalance = state.tokenBalances.get(targetMint) ?? 0n;
    const solBalance = state.solBalance;

    // Fetch token price in SOL terms via Jupiter price API
    // We need the token's USD price and SOL's USD price to compute the ratio
    let tokenPriceResult;
    let solPriceResult;
    try {
      [tokenPriceResult, solPriceResult] = await Promise.all([
        getTokenPrice(targetMintPk, this.connection),
        getTokenPrice(safePublicKey(WSOL_MINT), this.connection),
      ]);
    } catch {
      // Can't get prices — skip this tick
      return {
        type: 'noop',
        params: {},
        rationale: 'Could not fetch token prices for rebalancing calculation',
      };
    }

    if (!tokenPriceResult.priceUsd || !solPriceResult.priceUsd || solPriceResult.priceUsd === 0) {
      return {
        type: 'noop',
        params: {},
        rationale: 'Price data unavailable — skipping rebalance',
      };
    }

    // Compute portfolio value in USD
    const tokenDecimals = 6; // Assume 6 decimals (USDC-like); real impl fetches from chain
    const tokenValueUsd = Number(tokenBalance) / 10 ** tokenDecimals * tokenPriceResult.priceUsd;
    const solValueUsd = Number(solBalance) / 10 ** SOL_DECIMALS * solPriceResult.priceUsd;
    const totalValueUsd = tokenValueUsd + solValueUsd;

    if (totalValueUsd < 0.01) {
      return {
        type: 'noop',
        params: {},
        rationale: 'Portfolio value too small to rebalance (< $0.01)',
      };
    }

    const currentSolPct = (solValueUsd / totalValueUsd) * 100;
    const drift = Math.abs(currentSolPct - targetSolPct);

    // Within band — no action needed
    if (drift <= bandPct) {
      return {
        type: 'noop',
        params: {},
        rationale: `Portfolio within band: SOL ${currentSolPct.toFixed(1)}% vs target ${targetSolPct}% (drift ${drift.toFixed(1)}% <= band ${bandPct}%)`,
      };
    }

    // Outside band — compute rebalancing swap
    const targetSolValueUsd = totalValueUsd * (targetSolPct / 100);
    const solDeltaUsd = targetSolValueUsd - solValueUsd;
    const solDeltaLamports = BigInt(
      Math.abs(Math.round(solDeltaUsd / solPriceResult.priceUsd * 1e9))
    );

    // Minimum meaningful swap: 0.001 SOL
    if (solDeltaLamports < 1_000_000n) {
      return {
        type: 'noop',
        params: {},
        rationale: `Rebalance amount too small (${solDeltaLamports} lamports < 0.001 SOL minimum)`,
      };
    }

    const swapSolToToken = solDeltaUsd < 0; // Need less SOL → sell SOL; Need more SOL → sell token

    if (swapSolToToken) {
      // Sell SOL, buy token
      return {
        type: 'swap',
        params: {
          inputMint: WSOL_MINT,
          outputMint: targetMint,
          amountIn: solDeltaLamports,
          slippageBps: this.params.slippageBps,
          adapter: this.params.adapter,
        },
        rationale: `Rebalance: SOL ${currentSolPct.toFixed(1)}% > target ${targetSolPct}% — selling ${solDeltaLamports} lamports SOL for ${targetMint.slice(0, 8)}…`,
      };
    } else {
      // Sell token, buy SOL
      // Convert SOL delta to token amount
      const tokenDeltaRaw = BigInt(
        Math.abs(Math.round(-solDeltaUsd / tokenPriceResult.priceUsd * 10 ** tokenDecimals))
      );

      if (tokenDeltaRaw === 0n) {
        return {
          type: 'noop',
          params: {},
          rationale: 'Rebalance token delta rounds to 0',
        };
      }

      return {
        type: 'swap',
        params: {
          inputMint: targetMint,
          outputMint: WSOL_MINT,
          amountIn: tokenDeltaRaw,
          slippageBps: this.params.slippageBps,
          adapter: this.params.adapter,
        },
        rationale: `Rebalance: SOL ${currentSolPct.toFixed(1)}% < target ${targetSolPct}% — selling ${tokenDeltaRaw} token atoms for SOL`,
      };
    }
  }

  // ── execute() ───────────────────────────────────────────────────────────────

  async execute(
    action: Action,
    wallet: WalletClient,
    adapters: AdapterRegistry,
  ): Promise<TxResult | null> {
    if (action.type === 'noop') return null;
    if (action.type !== 'swap') {
      throw new Error(`Rebalancer strategy: unexpected action type '${action.type}'`);
    }

    const { inputMint, outputMint, amountIn, slippageBps, adapter } = action.params as {
      inputMint: string;
      outputMint: string;
      amountIn: bigint;
      slippageBps: number;
      adapter: 'jupiter' | 'orca' | 'best';
    };

    const inputPk = safePublicKey(inputMint);
    const outputPk = safePublicKey(outputMint);
    const amount = typeof amountIn === 'bigint' ? amountIn : BigInt(String(amountIn));

    let quote;
    let adapterName: 'jupiter' | 'orca';

    if (adapter === 'best') {
      const best = await adapters.getBestQuote(inputPk, outputPk, amount);
      quote = best.quote;
      adapterName = best.adapter;
    } else {
      const adp = adapters.get(adapter);
      quote = await adp.quote(inputPk, outputPk, amount);
      adapterName = adapter;
    }

    return adapters.get(adapterName).swap(wallet, quote, slippageBps);
  }
}
