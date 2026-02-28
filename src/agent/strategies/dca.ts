/**
 * @file src/agent/strategies/dca.ts
 *
 * Dollar-Cost Averaging (DCA) strategy.
 *
 * Decision logic (decide):
 *   - If SOL balance > minSolReserve AND amountPerTick <= SOL balance → swap
 *   - Otherwise → noop with human-readable rationale
 *
 * Execution (execute):
 *   - Gets best quote via registry (or named adapter if adapter param set)
 *   - Submits swap; returns TxResult
 *
 * Strategy params (from agents.json strategyParams):
 *   targetMint          string   Mint address of the token to accumulate
 *   amountPerTickLamports string | number  SOL to spend per tick (as string to handle bigint JSON)
 *   adapter             'jupiter' | 'orca' | 'best'  Which adapter to use (default: 'best')
 *   minSolReserveLamports string | number  Minimum SOL to keep (default: 50_000_000 = 0.05 SOL)
 */

import { ProtocolError } from '../../protocols/types.js';
import type { AdapterRegistry } from '../../protocols/types.js';
import { safePublicKey } from '../../utils.js';
import type { WalletClient, TxResult } from '../../wallet/types.js';
import type { Action, AgentState, Strategy } from '../types.js';

const DEFAULT_MIN_SOL_RESERVE = 50_000_000n;  // 0.05 SOL
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Validated params ──────────────────────────────────────────────────────────

interface DcaParams {
  targetMint: string;
  amountPerTickLamports: bigint;
  adapter: 'jupiter' | 'orca' | 'best';
  minSolReserveLamports: bigint;
}

function parseDcaParams(raw: Record<string, unknown>): DcaParams {
  const targetMint = raw['targetMint'];
  if (typeof targetMint !== 'string' || !targetMint) {
    throw new Error('DCA strategy: targetMint is required and must be a string');
  }
  // Validate it's a real public key
  try { safePublicKey(targetMint); } catch {
    throw new Error(`DCA strategy: targetMint "${targetMint}" is not a valid public key`);
  }

  const rawAmt = raw['amountPerTickLamports'];
  if (rawAmt === undefined) throw new Error('DCA strategy: amountPerTickLamports is required');
  const amountPerTickLamports = BigInt(String(rawAmt));
  if (amountPerTickLamports <= 0n) throw new Error('DCA strategy: amountPerTickLamports must be > 0');

  const rawAdapter = raw['adapter'] ?? 'best';
  if (!['jupiter', 'orca', 'best'].includes(String(rawAdapter))) {
    throw new Error(`DCA strategy: adapter must be 'jupiter', 'orca', or 'best'`);
  }

  const rawReserve = raw['minSolReserveLamports'] ?? DEFAULT_MIN_SOL_RESERVE.toString();
  const minSolReserveLamports = BigInt(String(rawReserve));

  return {
    targetMint,
    amountPerTickLamports,
    adapter: rawAdapter as 'jupiter' | 'orca' | 'best',
    minSolReserveLamports,
  };
}

// ── Strategy ──────────────────────────────────────────────────────────────────

export class DcaStrategy implements Strategy {
  readonly name = 'dca' as const;
  private readonly params: DcaParams;

  constructor(rawParams: Record<string, unknown>) {
    this.params = parseDcaParams(rawParams);
  }

  // ── decide() ────────────────────────────────────────────────────────────────

  async decide(state: AgentState): Promise<Action> {
    const { amountPerTickLamports, minSolReserveLamports, targetMint } = this.params;

    // Guard 1: enough SOL to maintain reserve after spending
    const requiredBalance = amountPerTickLamports + minSolReserveLamports;
    if (state.solBalance < requiredBalance) {
      return {
        type: 'noop',
        params: {},
        rationale: `Insufficient SOL: have ${state.solBalance} lamports, need ${requiredBalance} (${amountPerTickLamports} for swap + ${minSolReserveLamports} reserve)`,
      };
    }

    // Guard 2: don't swap SOL -> SOL
    if (targetMint === WSOL_MINT) {
      return {
        type: 'noop',
        params: {},
        rationale: 'targetMint is WSOL — cannot DCA into the same asset',
      };
    }

    // All checks pass — return a swap action
    return {
      type: 'swap',
      params: {
        inputMint: WSOL_MINT,
        outputMint: targetMint,
        amountIn: amountPerTickLamports,
        slippageBps: 100, // 1% — conservative for DCA
        adapter: this.params.adapter,
      },
      rationale: `DCA: swapping ${amountPerTickLamports} lamports of SOL -> ${targetMint}`,
    };
  }

  // ── execute() ───────────────────────────────────────────────────────────────

  async execute(
    action: Action,
    wallet: WalletClient,
    adapters: AdapterRegistry,
  ): Promise<TxResult | null> {
    if (action.type === 'noop') return null;
    if (action.type !== 'swap') {
      throw new Error(`DCA strategy: unexpected action type '${action.type}'`);
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

    // Get quote
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

    // Execute swap
    const result = await adapters.get(adapterName).swap(wallet, quote, slippageBps);
    return result;
  }
}
