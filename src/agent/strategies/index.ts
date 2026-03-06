/**
 * @file src/agent/strategies/index.ts
 * Strategy factory — maps strategy names to class constructors.
 * The agent manager calls createStrategy() with the config from agents.json.
 */

import { env, spendingLimits } from '../../config/env.js';
import { LLMDecider } from './llm.js';
import { UniversalStrategy } from './universal.js';
import type { Strategy } from '../types.js';

const llmDecider = new LLMDecider(spendingLimits);

/**
 * Creates and returns a Strategy instance.
 *
 * @param rpcUrl     RPC URL
 */
export function createStrategy(
  rpcUrl: string,
): Strategy {
  return new UniversalStrategy(llmDecider, rpcUrl);
}

export { UniversalStrategy } from './universal.js';
