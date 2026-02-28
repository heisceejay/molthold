/**
 * @file src/agent/strategies/index.ts
 * Strategy factory — maps strategy names to class constructors.
 * The agent manager calls createStrategy() with the config from agents.json.
 */

import { DcaStrategy } from './dca.js';
import { RebalancerStrategy } from './rebalancer.js';
import { MonitorStrategy } from './monitor.js';
import { MarketMakerStrategy } from './market-maker.js';
import type { Strategy, StrategyName } from '../types.js';

/**
 * Creates and returns a Strategy instance for the given name and params.
 * Throws if the strategy name is unknown or params are invalid.
 *
 * @param name       Strategy name from agents.json
 * @param params     Strategy-specific params from agents.json strategyParams
 * @param rpcUrl     RPC URL — some strategies need their own Connection for price reads
 */
export function createStrategy(
  name: StrategyName,
  params: Record<string, unknown>,
  rpcUrl: string,
): Strategy {
  switch (name) {
    case 'dca':
      return new DcaStrategy(params);

    case 'rebalancer':
      return new RebalancerStrategy(params, rpcUrl);

    case 'monitor':
      return new MonitorStrategy(params, rpcUrl);

    case 'market_maker':
      return new MarketMakerStrategy(params, rpcUrl);

    default: {
      // TypeScript exhaustiveness check
      const _: never = name;
      throw new Error(`Unknown strategy: ${String(_)}`);
    }
  }
}

export { DcaStrategy } from './dca.js';
export { RebalancerStrategy } from './rebalancer.js';
export { MonitorStrategy } from './monitor.js';
export { MarketMakerStrategy } from './market-maker.js';
