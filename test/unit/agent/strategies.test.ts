/**
 * Unit tests for all three strategy implementations.
 *
 * Test gates from implementation plan:
 *  ✅ DCA strategy returns noop when SOL balance below reserve
 *  ✅ DCA strategy returns swap when balance is sufficient
 *  ✅ Rebalancer returns noop when within band
 *  ✅ Rebalancer returns swap action when out of band
 *  ✅ Monitor always returns noop
 *  ✅ createStrategy factory throws on unknown name
 *  ✅ Invalid params throw on construction
 *
 * These tests call ONLY decide() — no wallet, no adapters, no network.
 * The rebalancer tests mock getTokenPrice via vi.mock to avoid HTTP calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DcaStrategy } from '../../../src/agent/strategies/dca.js';
import { RebalancerStrategy } from '../../../src/agent/strategies/rebalancer.js';
import { MonitorStrategy } from '../../../src/agent/strategies/monitor.js';
import { createStrategy } from '../../../src/agent/strategies/index.js';
import type { AgentState } from '../../../src/agent/types.js';

// ── Mock the price RPC call so rebalancer tests don't hit the network ─────────

vi.mock('../../../src/protocols/rpc.js', () => ({
  getTokenPrice:  vi.fn(),
  getTokenPrices: vi.fn().mockResolvedValue(new Map()),
  accountExists:  vi.fn().mockResolvedValue(true),
  getPoolReserves: vi.fn(),
}));

// ── Shared test helpers ───────────────────────────────────────────────────────

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const RPC_URL   = 'https://api.devnet.solana.com';

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId:       'test-agent',
    walletPubkey:  'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW',
    solBalance:    500_000_000n, // 0.5 SOL default
    tokenBalances: new Map(),
    lastActionAt:  null,
    tickCount:     1,
    snapshotAt:    Date.now(),
    ...overrides,
  };
}

// ── DCA strategy ──────────────────────────────────────────────────────────────

describe('DcaStrategy.decide()', () => {
  const BASE_PARAMS = {
    targetMint:            USDC_MINT,
    amountPerTickLamports: '10000000',  // 0.01 SOL
    minSolReserveLamports: '50000000',  // 0.05 SOL reserve
    adapter:               'best',
  };

  it('GATE: returns noop when SOL balance is below reserve + amount', async () => {
    const strategy = new DcaStrategy(BASE_PARAMS);
    // Need 0.01 + 0.05 = 0.06 SOL = 60_000_000 lamports, but have 0.055 SOL
    const state = makeState({ solBalance: 55_000_000n });
    const action = await strategy.decide(state);

    expect(action.type).toBe('noop');
    expect(action.rationale).toContain('Insufficient SOL');
    expect(action.rationale).toContain('55000000');
  });

  it('GATE: returns noop when exactly at minimum reserve (not enough for swap)', async () => {
    const strategy = new DcaStrategy(BASE_PARAMS);
    // Exactly the reserve — still not enough to also do the swap
    const state = makeState({ solBalance: 50_000_000n });
    const action = await strategy.decide(state);
    expect(action.type).toBe('noop');
  });

  it('GATE: returns swap when balance exceeds reserve + amount', async () => {
    const strategy = new DcaStrategy(BASE_PARAMS);
    const state    = makeState({ solBalance: 200_000_000n }); // 0.2 SOL
    const action   = await strategy.decide(state);

    expect(action.type).toBe('swap');
    expect(action.params['inputMint']).toBe(WSOL_MINT);
    expect(action.params['outputMint']).toBe(USDC_MINT);
    expect(action.params['amountIn']).toBe(10_000_000n);
    expect(action.params['slippageBps']).toBe(100);
    expect(action.rationale).toContain('DCA');
  });

  it('returns noop when targetMint is WSOL (no SOL→SOL swap)', async () => {
    const strategy = new DcaStrategy({ ...BASE_PARAMS, targetMint: WSOL_MINT });
    const state    = makeState({ solBalance: 500_000_000n });
    const action   = await strategy.decide(state);
    expect(action.type).toBe('noop');
    expect(action.rationale).toContain('WSOL');
  });

  it('swap action adapter defaults to "best"', async () => {
    const strategy = new DcaStrategy({ ...BASE_PARAMS });
    const state    = makeState({ solBalance: 500_000_000n });
    const action   = await strategy.decide(state);
    expect(action.params['adapter']).toBe('best');
  });

  it('swap action uses named adapter when specified', async () => {
    const strategy = new DcaStrategy({ ...BASE_PARAMS, adapter: 'jupiter' });
    const state    = makeState({ solBalance: 500_000_000n });
    const action   = await strategy.decide(state);
    expect(action.params['adapter']).toBe('jupiter');
  });
});

describe('DcaStrategy — param validation', () => {
  it('throws when targetMint is missing', () => {
    expect(() => new DcaStrategy({ amountPerTickLamports: '1000000' })).toThrow(/targetMint/);
  });

  it('throws when targetMint is an invalid public key', () => {
    expect(() => new DcaStrategy({ targetMint: 'not-a-pubkey', amountPerTickLamports: '1000000' })).toThrow(/valid public key/);
  });

  it('throws when amountPerTickLamports is missing', () => {
    expect(() => new DcaStrategy({ targetMint: USDC_MINT })).toThrow(/amountPerTickLamports/);
  });

  it('throws when amountPerTickLamports is zero', () => {
    expect(() => new DcaStrategy({ targetMint: USDC_MINT, amountPerTickLamports: '0' })).toThrow(/must be > 0/);
  });

  it('throws on invalid adapter name', () => {
    expect(() => new DcaStrategy({ targetMint: USDC_MINT, amountPerTickLamports: '1000', adapter: 'uniswap' })).toThrow(/adapter/);
  });
});

// ── Rebalancer strategy ───────────────────────────────────────────────────────

describe('RebalancerStrategy.decide()', () => {
  let getTokenPrice: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const rpcMod = await import('../../../src/protocols/rpc.js');
    getTokenPrice = rpcMod.getTokenPrice as ReturnType<typeof vi.fn>;
  });

  const BASE_PARAMS = {
    targetMint:   USDC_MINT,
    targetSolPct: 50,   // target 50% SOL
    bandPct:      5,    // ±5% band
    adapter:      'jupiter',
    slippageBps:  100,
  };

  function mockPrices(solPrice: number, tokenPrice: number): void {
    getTokenPrice.mockImplementation(async (mint: { toBase58: () => string }) => {
      const isWsol = mint.toBase58() === WSOL_MINT;
      return {
        mint:     mint.toBase58(),
        priceUsd: isWsol ? solPrice : tokenPrice,
        source:   'jupiter',
        fetchedAt: Date.now(),
      };
    });
  }

  it('GATE: returns noop when portfolio is within band', async () => {
    // SOL = $100, token = $1 (6 decimals)
    // 0.5 SOL = $50, 50_000_000 token atoms = 50 tokens = $50
    // Total = $100, SOL pct = 50% — right at target, within ±5% band
    mockPrices(100, 1);
    const strategy = new RebalancerStrategy(BASE_PARAMS, RPC_URL);
    const state = makeState({
      solBalance:    500_000_000n,         // 0.5 SOL
      tokenBalances: new Map([[USDC_MINT, 50_000_000n]]), // 50 USDC @ 6 decimals
    });

    const action = await strategy.decide(state);
    expect(action.type).toBe('noop');
    expect(action.rationale).toContain('within band');
  });

  it('GATE: returns swap when SOL allocation exceeds target + band', async () => {
    // SOL = $100, USDC = $1
    // 0.5 SOL = $50, 10 USDC = $10 → total $60
    // SOL pct = 83.3% >> target 50% + 5% band — must rebalance (sell SOL, buy USDC)
    mockPrices(100, 1);
    const strategy = new RebalancerStrategy(BASE_PARAMS, RPC_URL);
    const state = makeState({
      solBalance:    500_000_000n,
      tokenBalances: new Map([[USDC_MINT, 10_000_000n]]), // only 10 USDC
    });

    const action = await strategy.decide(state);
    expect(action.type).toBe('swap');
    expect(action.params['inputMint']).toBe(WSOL_MINT);   // sell SOL
    expect(action.params['outputMint']).toBe(USDC_MINT);  // buy USDC
    expect(action.params['slippageBps']).toBe(100);
    expect(action.rationale).toContain('Rebalance');
    expect(action.rationale).toContain('>');
  });

  it('GATE: returns swap when SOL allocation is below target - band (buy SOL)', async () => {
    // 0.1 SOL = $10, 200 USDC = $200 → total $210
    // SOL pct = 4.8% << target 50% - 5% — must rebalance (sell USDC, buy SOL)
    mockPrices(100, 1);
    const strategy = new RebalancerStrategy(BASE_PARAMS, RPC_URL);
    const state = makeState({
      solBalance:    100_000_000n,                            // 0.1 SOL
      tokenBalances: new Map([[USDC_MINT, 200_000_000n]]),    // 200 USDC
    });

    const action = await strategy.decide(state);
    expect(action.type).toBe('swap');
    expect(action.params['inputMint']).toBe(USDC_MINT);   // sell token
    expect(action.params['outputMint']).toBe(WSOL_MINT);  // buy SOL
    expect(action.rationale).toContain('<');
  });

  it('returns noop when price data is unavailable', async () => {
    getTokenPrice.mockResolvedValue({ mint: USDC_MINT, priceUsd: null, source: 'unknown', fetchedAt: Date.now() });
    const strategy = new RebalancerStrategy(BASE_PARAMS, RPC_URL);
    const state    = makeState();
    const action   = await strategy.decide(state);
    expect(action.type).toBe('noop');
    expect(action.rationale).toContain('unavailable');
  });

  it('returns noop when portfolio value is near zero', async () => {
    mockPrices(100, 1);
    const strategy = new RebalancerStrategy(BASE_PARAMS, RPC_URL);
    const state    = makeState({ solBalance: 1n, tokenBalances: new Map([[USDC_MINT, 1n]]) });
    const action   = await strategy.decide(state);
    expect(action.type).toBe('noop');
    expect(action.rationale).toContain('too small');
  });

  it('returns noop when price fetch throws', async () => {
    getTokenPrice.mockRejectedValue(new Error('network error'));
    const strategy = new RebalancerStrategy(BASE_PARAMS, RPC_URL);
    const state    = makeState();
    const action   = await strategy.decide(state);
    expect(action.type).toBe('noop');
    expect(action.rationale).toContain('Could not fetch');
  });

  it('noop rationale includes current allocation and target', async () => {
    mockPrices(100, 1);
    const strategy = new RebalancerStrategy(BASE_PARAMS, RPC_URL);
    const state = makeState({
      solBalance:    500_000_000n,
      tokenBalances: new Map([[USDC_MINT, 50_000_000n]]),
    });
    const action = await strategy.decide(state);
    expect(action.type).toBe('noop');
    expect(action.rationale).toContain('50'); // target pct
    expect(action.rationale).toContain('band');
  });
});

describe('RebalancerStrategy — param validation', () => {
  it('throws on missing targetMint', () => {
    expect(() => new RebalancerStrategy({ targetSolPct: 50, bandPct: 5 }, RPC_URL)).toThrow(/targetMint/);
  });

  it('throws when targetSolPct is out of range', () => {
    expect(() => new RebalancerStrategy({ targetMint: USDC_MINT, targetSolPct: 110, bandPct: 5 }, RPC_URL)).toThrow(/targetSolPct/);
    expect(() => new RebalancerStrategy({ targetMint: USDC_MINT, targetSolPct: -5, bandPct: 5 }, RPC_URL)).toThrow(/targetSolPct/);
  });

  it('throws when bandPct is too large', () => {
    expect(() => new RebalancerStrategy({ targetMint: USDC_MINT, targetSolPct: 50, bandPct: 60 }, RPC_URL)).toThrow(/bandPct/);
  });
});

// ── Monitor strategy ──────────────────────────────────────────────────────────

describe('MonitorStrategy.decide()', () => {
  it('GATE: always returns noop', async () => {
    const strategy = new MonitorStrategy({ trackedMints: [] }, RPC_URL);
    const state    = makeState();
    const action   = await strategy.decide(state);
    expect(action.type).toBe('noop');
  });

  it('execute() always returns null', async () => {
    const strategy = new MonitorStrategy({ trackedMints: [] }, RPC_URL);
    const state    = makeState();
    const action   = await strategy.decide(state);
    const result   = await strategy.execute(action, {} as never, {} as never);
    expect(result).toBeNull();
  });

  it('rationale includes tick count and SOL balance', async () => {
    const strategy = new MonitorStrategy({ trackedMints: [] }, RPC_URL);
    const state    = makeState({ tickCount: 7, solBalance: 123_000_000n });
    const action   = await strategy.decide(state);
    expect(action.rationale).toContain('7');
    expect(action.rationale).toContain('123000000');
  });
});

// ── createStrategy factory ────────────────────────────────────────────────────

describe('createStrategy()', () => {
  it('creates a DcaStrategy for name "dca"', () => {
    const s = createStrategy('dca', { targetMint: USDC_MINT, amountPerTickLamports: '1000000' }, RPC_URL);
    expect(s.name).toBe('dca');
  });

  it('creates a RebalancerStrategy for name "rebalancer"', () => {
    const s = createStrategy('rebalancer', { targetMint: USDC_MINT, targetSolPct: 50, bandPct: 5 }, RPC_URL);
    expect(s.name).toBe('rebalancer');
  });

  it('creates a MonitorStrategy for name "monitor"', () => {
    const s = createStrategy('monitor', {}, RPC_URL);
    expect(s.name).toBe('monitor');
  });

  it('GATE: throws for unknown strategy name', () => {
    expect(() => createStrategy('unknown' as 'dca', {}, RPC_URL)).toThrow();
  });
});
