/**
 * Unit tests for UniversalStrategy — delegation and execution verification.
 */

import { describe, it, expect, vi } from 'vitest';
import { UniversalStrategy } from '../../../src/agent/strategies/universal.js';
import { createStrategy } from '../../../src/agent/strategies/index.js';
import type { AgentState } from '../../../src/agent/types.js';

// ── Mock LLMDecider ──────────────────────────────────────────────────────────

const mockLLMDecider = {
  decide: vi.fn(),
};

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RPC_URL = 'https://api.devnet.solana.com';

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'test-agent',
    walletPubkey: 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW',
    solBalance: 500_000_000n,
    tokenBalances: new Map(),
    lastActionAt: null,
    tickCount: 1,
    snapshotAt: Date.now(),
    ...overrides,
  };
}

describe('UniversalStrategy', () => {

  it('delegates decide() to llmDecider', async () => {
    const strategy = new UniversalStrategy(mockLLMDecider as any, RPC_URL);
    const state = makeState();
    mockLLMDecider.decide.mockResolvedValue({ type: 'swap', rationale: 'LLM decided' });

    const action = await strategy.decide(state);
    expect(mockLLMDecider.decide).toHaveBeenCalled();
    expect(action.type).toBe('swap');
  });

  describe('execute()', () => {
    it('returns null for noop', async () => {
      const strategy = new UniversalStrategy(mockLLMDecider as any, RPC_URL);
      const action = { type: 'noop', params: {}, rationale: 'test' };
      const result = await strategy.execute(action as any, {} as any, {} as any);
      expect(result).toBeNull();
    });

    it('throws for unknown action type', async () => {
      const strategy = new UniversalStrategy(mockLLMDecider as any, RPC_URL);
      const action = { type: 'unknown' as any, params: {}, rationale: 'test' };
      const result = await strategy.execute(action as any, {} as any, {} as any);
      expect(result?.status).toBe('failed');
      expect(result?.error).toContain('unknown action type');
    });
  });
});

describe('createStrategy() factory', () => {
  it('creates UniversalStrategy always', () => {
    const strategy = createStrategy(RPC_URL);
    expect(strategy.name).toBe('universal');
  });
});
