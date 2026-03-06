/**
 * @file src/agent/index.ts
 * Public API for the agent module.
 */

export { AgentLoop } from './loop.js';
export { MultiAgentManager, loadAgentConfigs } from './manager.js';
export { createStrategy, UniversalStrategy } from './strategies/index.js';
export type {
  AgentConfig,
  AgentState,
  AgentLoopState,
  AgentLoopStatus,
  Action,
  Strategy,
  SwapActionParams,
  TransferActionParams,
} from './types.js';
