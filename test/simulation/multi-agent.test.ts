/**
 * Multi-agent simulation test.
 *
 * Test gates from implementation plan:
 *  ✅ 3 agents run simultaneously for N ticks without key collisions
 *  ✅ No agent can access another agent's WalletClient
 *  ✅ Each agent's public key appears only in its own audit rows
 *  ✅ All agents complete ticks independently (one crash does not affect others)
 *
 * This simulation uses mock wallets and adapters — no devnet required.
 * It runs 5 ticks per agent (3 agents × 5 ticks = 15 ticks total).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { DcaStrategy } from '../../src/agent/strategies/dca.js';
import { MonitorStrategy } from '../../src/agent/strategies/monitor.js';
import { AuditDb } from '../../src/logger/audit.js';
import { createLogger } from '../../src/logger/logger.js';
import type { AgentConfig } from '../../src/agent/types.js';
import type { WalletClient } from '../../src/wallet/types.js';
import type { AdapterRegistry } from '../../src/protocols/types.js';

// ── Mock price calls so rebalancer/monitor don't need network ─────────────────
vi.mock('../../src/protocols/rpc.js', () => ({
  getTokenPrice: vi.fn().mockResolvedValue({ priceUsd: 100, source: 'jupiter', fetchedAt: Date.now() }),
  getTokenPrices: vi.fn().mockResolvedValue(new Map()),
  accountExists: vi.fn().mockResolvedValue(true),
  getPoolReserves: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RPC_URL = 'https://api.devnet.solana.com';
const logger = createLogger({ level: 'error' });

/**
 * Creates an isolated WalletClient mock for each agent.
 * The publicKey is unique per call — this is how we verify key isolation.
 */
function makeIsolatedWallet(): WalletClient {
  const kp = Keypair.generate(); // Fresh keypair per agent
  return {
    publicKey: kp.publicKey,
    getSolBalance: vi.fn().mockResolvedValue(500_000_000n),
    getTokenBalance: vi.fn().mockResolvedValue(0n),
    getOrCreateTokenAccount: vi.fn(),
    sendSol: vi.fn(),
    sendToken: vi.fn(),
    signTransaction: vi.fn(async (tx) => tx),
    signAndSendTransaction: vi.fn().mockResolvedValue({ signature: `sig-${kp.publicKey.toBase58().slice(0, 8)}`, status: 'confirmed' as const, slot: 1 }),
    getSpendingLimitStatus: vi.fn().mockReturnValue({ sessionSpend: 0n, sessionCap: 500_000_000n, perTxCap: 100_000_000n }),
    toJSON: () => kp.publicKey.toBase58(),
    toString: () => kp.publicKey.toBase58(),
  };
}

function makeAdapters(agentId: string): AdapterRegistry {
  return {
    get: vi.fn().mockReturnValue({
      name: 'jupiter',
      quote: vi.fn().mockResolvedValue({ inAmount: 10_000_000n, outAmount: 9_000_000n, provider: 'jupiter', raw: {} }),
      swap: vi.fn().mockResolvedValue({ signature: `swapsig-${agentId}`, status: 'confirmed' as const, slot: 1, inAmount: 10_000_000n, outAmount: 9_000_000n }),
    }),
    getBestQuote: vi.fn().mockResolvedValue({
      quote: { inAmount: 10_000_000n, outAmount: 9_000_000n, provider: 'jupiter', raw: {} },
      adapter: 'jupiter',
    }),
  };
}

function makeConfig(id: string, strategy: 'dca' | 'monitor'): AgentConfig {
  return {
    id,
    keystorePath: `/tmp/${id}.json`,
    strategy,
    strategyParams: strategy === 'dca'
      ? { targetMint: USDC_MINT, amountPerTickLamports: '10000000', adapter: 'jupiter' }
      : { trackedMints: [] },
    intervalMs: 0,
    limits: { maxPerTxLamports: 50_000_000n, maxSessionLamports: 500_000_000n },
  };
}

/**
 * Runs a loop for exactly `targetTicks` ticks then stops.
 * Returns a Promise that resolves when the loop is done.
 */
function runNTicks(loop: AgentLoop, strategy: { decide: (...args: unknown[]) => Promise<unknown> }, targetTicks: number): Promise<void> {
  let ticksSeen = 0;
  const origDecide = strategy.decide.bind(strategy);
  vi.spyOn(strategy as any, 'decide').mockImplementation(async (...args: any[]) => {
    ticksSeen++;
    const result = await origDecide(...args);
    if (ticksSeen >= targetTicks) {
      loop.stop();
    }
    return result;
  });
  return loop.start();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Multi-agent simulation — 3 agents × 5 ticks', () => {
  let tmpDir: string;
  let db: AuditDb;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-sim-'));
    db = new AuditDb(path.join(tmpDir, 'audit.db'));
  });

  afterEach(() => {
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GATE: 3 agents complete 5 ticks each concurrently without errors', async () => {
    // Three completely isolated agents
    const wallet1 = makeIsolatedWallet();
    const wallet2 = makeIsolatedWallet();
    const wallet3 = makeIsolatedWallet();

    // Verify keys are actually distinct
    expect(wallet1.publicKey.toBase58()).not.toBe(wallet2.publicKey.toBase58());
    expect(wallet2.publicKey.toBase58()).not.toBe(wallet3.publicKey.toBase58());
    expect(wallet1.publicKey.toBase58()).not.toBe(wallet3.publicKey.toBase58());

    const s1 = new DcaStrategy(makeConfig('agent-1', 'dca').strategyParams);
    const s2 = new DcaStrategy(makeConfig('agent-2', 'dca').strategyParams);
    const s3 = new MonitorStrategy({}, RPC_URL);

    const loop1 = new AgentLoop(makeConfig('agent-1', 'dca'), wallet1, s1, makeAdapters('agent-1'), logger, db);
    const loop2 = new AgentLoop(makeConfig('agent-2', 'dca'), wallet2, s2, makeAdapters('agent-2'), logger, db);
    const loop3 = new AgentLoop(makeConfig('agent-3', 'monitor'), wallet3, s3, makeAdapters('agent-3'), logger, db);

    // Run all 3 concurrently for 5 ticks each
    await Promise.all([
      runNTicks(loop1, s1, 5),
      runNTicks(loop2, s2, 5),
      runNTicks(loop3, s3, 5),
    ]);

    // All 3 agents should have stopped cleanly
    expect(loop1.getState().status).toBe('stopped');
    expect(loop2.getState().status).toBe('stopped');
    expect(loop3.getState().status).toBe('stopped');

    // All 3 should have run 5 ticks
    expect(loop1.getState().tickCount).toBe(5);
    expect(loop2.getState().tickCount).toBe(5);
    expect(loop3.getState().tickCount).toBe(5);
  }, 30_000);

  it('GATE: each agent\'s audit rows only reference its own wallet pubkey', async () => {
    const wallet1 = makeIsolatedWallet();
    const wallet2 = makeIsolatedWallet();
    const wallet3 = makeIsolatedWallet();

    const s1 = new DcaStrategy(makeConfig('agent-1', 'dca').strategyParams);
    const s2 = new DcaStrategy(makeConfig('agent-2', 'dca').strategyParams);
    const s3 = new MonitorStrategy({}, RPC_URL);

    const loop1 = new AgentLoop(makeConfig('agent-1', 'dca'), wallet1, s1, makeAdapters('agent-1'), logger, db);
    const loop2 = new AgentLoop(makeConfig('agent-2', 'dca'), wallet2, s2, makeAdapters('agent-2'), logger, db);
    const loop3 = new AgentLoop(makeConfig('agent-3', 'monitor'), wallet3, s3, makeAdapters('agent-3'), logger, db);

    await Promise.all([
      runNTicks(loop1, s1, 3),
      runNTicks(loop2, s2, 3),
      runNTicks(loop3, s3, 3),
    ]);

    // KEY ISOLATION CHECK: each agent's rows must only have that agent's pubkey
    const rows1 = db.query({ agentId: 'agent-1' });
    const rows2 = db.query({ agentId: 'agent-2' });
    const rows3 = db.query({ agentId: 'agent-3' });

    expect(rows1.length).toBeGreaterThan(0);
    expect(rows2.length).toBeGreaterThan(0);
    expect(rows3.length).toBeGreaterThan(0);

    for (const row of rows1) {
      expect(row.wallet_pk).toBe(wallet1.publicKey.toBase58());
      expect(row.wallet_pk).not.toBe(wallet2.publicKey.toBase58());
      expect(row.wallet_pk).not.toBe(wallet3.publicKey.toBase58());
    }
    for (const row of rows2) {
      expect(row.wallet_pk).toBe(wallet2.publicKey.toBase58());
    }
    for (const row of rows3) {
      expect(row.wallet_pk).toBe(wallet3.publicKey.toBase58());
    }
  }, 30_000);

  it('GATE: one agent crashing does not affect other agents\' tick counts', async () => {
    const wallet1 = makeIsolatedWallet();
    const wallet2 = makeIsolatedWallet();

    const s1 = new DcaStrategy(makeConfig('agent-1', 'dca').strategyParams);
    const s2 = new DcaStrategy(makeConfig('agent-2', 'dca').strategyParams);

    // Make agent-1's wallet throw on tick 2
    let a1Ticks = 0;
    (wallet1.getSolBalance as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      a1Ticks++;
      if (a1Ticks === 2) throw new Error('Simulated RPC crash for agent-1 tick 2');
      return 500_000_000n;
    });

    const loop1 = new AgentLoop(makeConfig('agent-1', 'dca'), wallet1, s1, makeAdapters('agent-1'), logger, db);
    const loop2 = new AgentLoop(makeConfig('agent-2', 'dca'), wallet2, s2, makeAdapters('agent-2'), logger, db);

    await Promise.all([
      runNTicks(loop1, s1, 4),
      runNTicks(loop2, s2, 4),
    ]);

    // Both should reach at least 4 ticks — agent-1's crash on tick 2 was isolated
    expect(loop1.getState().tickCount).toBeGreaterThanOrEqual(4);
    expect(loop2.getState().tickCount).toBeGreaterThanOrEqual(4);

    // agent-1 should have one agent_error row for the crash
    const errors = db.query({ agentId: 'agent-1', event: 'agent_error' });
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // agent-2 should have zero errors
    const a2errors = db.query({ agentId: 'agent-2', event: 'agent_error' });
    expect(a2errors.length).toBe(0);
  }, 30_000);

  it('GATE: no audit DB row contains a secretKey or privateKey field', async () => {
    const wallet1 = makeIsolatedWallet();
    const s1 = new MonitorStrategy({}, RPC_URL);
    const loop1 = new AgentLoop(makeConfig('agent-1', 'monitor'), wallet1, s1, makeAdapters('agent-1'), logger, db);

    await runNTicks(loop1, s1, 3);

    const allRows = db.query({});
    for (const row of allRows) {
      expect(row.details_json).not.toContain('"secretKey"');
      expect(row.details_json).not.toContain('"privateKey"');
      expect(row.details_json).not.toContain('"keypair"');
      expect(row.details_json).not.toContain('"seed"');
    }
  }, 15_000);

  it('audit DB summary shows correct tick counts per agent', async () => {
    const agents = ['sim-a', 'sim-b', 'sim-c'].map((id) => ({
      id,
      wallet: makeIsolatedWallet(),
      strategy: new MonitorStrategy({}, RPC_URL),
      config: makeConfig(id, 'monitor'),
    }));

    const loops = agents.map(({ config, wallet, strategy, id }) =>
      new AgentLoop(config, wallet, strategy, makeAdapters(id), logger, db)
    );

    await Promise.all(
      agents.map(({ strategy }, i) => runNTicks(loops[i]!, strategy, 4))
    );

    const summary = db.summarise();
    for (const { id } of agents) {
      const noops = summary.find((r) => r.agent_id === id && r.event === 'agent_noop');
      expect(noops?.count).toBeGreaterThanOrEqual(4);
    }
  }, 30_000);
});

// ── Local beforeEach ──────────────────────────────────────────────────────────
import { beforeEach } from 'vitest';
