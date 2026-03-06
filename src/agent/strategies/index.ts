/**
 * @file src/agent/strategies/index.ts
 * Strategy factory — maps strategy names to class constructors.
 * The agent manager calls createStrategy() with the config from agents.json.
 */

import { LLMDecider } from './llm.js';
import { UniversalStrategy } from './universal.js';
import type { Strategy } from '../types.js';
import type { SpendingLimits } from '../../wallet/types.js';
import type { Logger } from '../../logger/logger.js';

/**
 * Creates and returns a Strategy instance.
 *
 * @param rpcUrl     RPC URL
 * @param limits     Spending limits for the agent
 * @param logger     Agent-specific logger
 */
export function createStrategy(
  rpcUrl: string,
  limits: SpendingLimits,
  logger: Logger,
): Strategy {
  const llmDecider = new LLMDecider(limits, logger);
  return new UniversalStrategy(llmDecider, rpcUrl);
}

export { UniversalStrategy } from './universal.js';
