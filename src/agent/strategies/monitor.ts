/**
 * @file src/agent/strategies/monitor.ts
 *
 * Monitor strategy — read-only, never transacts.
 *
 * Logs balances and token prices each tick. Used to:
 *   - Validate the observability stack without spending real funds
 *   - Provide a safe default for demo environments
 *   - Serve as the reference for the "agent-3" in multi-agent simulations
 *
 * Strategy params:
 *   trackedMints   string[]  Mint addresses to report balances for
 */

import { PublicKey } from '@solana/web3.js';
import { getTokenPrices } from '../../protocols/rpc.js';
import { Connection } from '@solana/web3.js';
import { ProtocolError } from '../../protocols/types.js';
import { safePublicKey } from '../../utils.js';
import type { AdapterRegistry } from '../../protocols/types.js';
import type { WalletClient, TxResult } from '../../wallet/types.js';
import type { Action, AgentState, Strategy } from '../types.js';

interface MonitorParams {
  trackedMints: string[];
  rpcUrl: string;
}

function parseMonitorParams(raw: Record<string, unknown>, rpcUrl: string): MonitorParams {
  const trackedMints = Array.isArray(raw['trackedMints'])
    ? (raw['trackedMints'] as unknown[]).filter((m): m is string => typeof m === 'string')
    : [];

  return { trackedMints, rpcUrl };
}

export class MonitorStrategy implements Strategy {
  readonly name = 'monitor' as const;
  private readonly params: MonitorParams;
  private readonly connection: Connection;

  constructor(rawParams: Record<string, unknown>, rpcUrl: string) {
    this.params = parseMonitorParams(rawParams, rpcUrl);
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  async decide(state: AgentState): Promise<Action> {
    // Build a snapshot of everything we can see
    const balanceSummary: Record<string, string> = {
      sol: state.solBalance.toString(),
    };

    for (const [mint, balance] of state.tokenBalances) {
      balanceSummary[`token_${mint.slice(0, 8)}`] = balance.toString();
    }

    // Fetch USD prices for tracked mints
    let priceSummary: Record<string, string> = {};
    if (this.params.trackedMints) {
      try {
        const mintPks = this.params.trackedMints.map((m) => safePublicKey(m));
        const prices = await getTokenPrices(mintPks, this.connection);
        for (const [mint, result] of prices) {
          priceSummary[`price_${mint.slice(0, 8)}`] = result.priceUsd !== null
            ? `$${result.priceUsd.toFixed(4)}`
            : 'unknown';
        }
      } catch {
        priceSummary = { priceError: 'fetch failed' };
      }
    }

    return {
      type: 'noop',
      params: { ...balanceSummary, ...priceSummary },
      rationale: `Monitor tick ${state.tickCount}: SOL=${state.solBalance} lamports, tokens=${state.tokenBalances.size} tracked`,
    };
  }

  async execute(
    _action: Action,
    _wallet: WalletClient,
    _adapters: AdapterRegistry,
  ): Promise<TxResult | null> {
    // Monitor never executes transactions
    return null;
  }
}
