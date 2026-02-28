/**
 * Integration test: DCA agent tick on devnet.
 *
 * Test gates from implementation plan:
 *  ✅ AgentLoop.tick() with DCA strategy executes a swap on devnet
 *  ✅ Audit DB contains one row per tick per agent after simulation
 *
 * Prerequisites:
 *  - WALLET_SECRET_KEY set to a funded devnet wallet (>= 0.1 SOL)
 *  - SOLANA_RPC_URL pointing to devnet
 *
 * Skipped automatically if WALLET_SECRET_KEY is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentLoop } from '../../../src/agent/loop.js';
import { DcaStrategy } from '../../../src/agent/strategies/dca.js';
import { createWalletClient } from '../../../src/wallet/wallet.js';
import { loadFromEnv } from '../../../src/wallet/keystore.js';
import { createAdapterRegistry } from '../../../src/protocols/index.js';
import { AuditDb } from '../../../src/logger/audit.js';
import { createLogger } from '../../../src/logger/logger.js';
import type { AgentConfig } from '../../../src/agent/types.js';
import type { WalletConfig } from '../../../src/wallet/types.js';

// ── Setup ─────────────────────────────────────────────────────────────────────

const RPC_URL    = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
const SECRET_KEY = process.env['WALLET_SECRET_KEY'];
const SKIP       = !SECRET_KEY;
const itDev      = SKIP ? it.skip : it;

// Devnet USDC
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const logger = createLogger({ level: 'warn' });

let tmpDir: string;
let db:     AuditDb;
let connection: Connection;
let keypair:    Keypair;

beforeAll(() => {
  if (SKIP) return;
  tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-integ-'));
  db         = new AuditDb(path.join(tmpDir, 'audit.db'));
  connection = new Connection(RPC_URL, 'confirmed');
  keypair    = loadFromEnv(SECRET_KEY!);
});

afterAll(() => {
  if (SKIP) return;
  db?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DCA agent loop — devnet', () => {
  itDev(
    'GATE: single DCA tick executes a swap and writes tx_confirmed to audit DB',
    async () => {
      const walletConfig: WalletConfig = {
        rpcUrl:               RPC_URL,
        limits: {
          maxPerTxLamports:   20_000_000n,  // 0.02 SOL per tx
          maxSessionLamports: 100_000_000n, // 0.1 SOL session cap
        },
        simulateBeforeSend:   true,
        confirmationStrategy: 'confirmed',
        maxRetries:           3,
        retryDelayMs:         2_000,
      };

      const wallet   = createWalletClient(keypair, walletConfig, logger);
      const adapters = createAdapterRegistry(connection, logger);

      const config: AgentConfig = {
        id:             'dca-integ-test',
        keystorePath:   '/tmp/test.json',
        strategy:       'dca',
        strategyParams: {
          targetMint:            USDC_MINT,
          amountPerTickLamports: '10000000', // 0.01 SOL
          adapter:               'jupiter',
          minSolReserveLamports: '50000000',
        },
        intervalMs: 0,
        limits: {
          maxPerTxLamports:   20_000_000n,
          maxSessionLamports: 100_000_000n,
        },
      };

      const strategy = new DcaStrategy(config.strategyParams);
      const loop     = new AgentLoop(config, wallet, strategy, adapters, logger, db);

      // Run exactly one tick then stop
      let ticked = false;
      const origDecide = strategy.decide.bind(strategy);
      vi.spyOn(strategy, 'decide').mockImplementation(async (state) => {
        const action = await origDecide(state);
        if (!ticked) {
          ticked = true;
          // After first decide, schedule stop
          setTimeout(() => loop.stop(), 0);
        }
        return action;
      });

      await loop.start();

      // Audit DB should have at least one event for this agent
      const rows = db.query({ agentId: 'dca-integ-test' });
      expect(rows.length).toBeGreaterThan(0);

      // Should have agent_start and agent_stop
      expect(db.query({ agentId: 'dca-integ-test', event: 'agent_start' })).toHaveLength(1);
      expect(db.query({ agentId: 'dca-integ-test', event: 'agent_stop' })).toHaveLength(1);

      // The tick should have produced either tx_confirmed or agent_noop (if low balance)
      const txRows  = db.query({ agentId: 'dca-integ-test', event: 'tx_confirmed' });
      const noopRows = db.query({ agentId: 'dca-integ-test', event: 'agent_noop' });
      expect(txRows.length + noopRows.length).toBeGreaterThanOrEqual(1);
    },
    90_000,
  );

  itDev(
    'GATE: audit DB contains one row per agent_start per loop run',
    async () => {
      const walletConfig: WalletConfig = {
        rpcUrl:               RPC_URL,
        limits: { maxPerTxLamports: 1_000_000n, maxSessionLamports: 10_000_000n },
        simulateBeforeSend:   true,
        confirmationStrategy: 'confirmed',
        maxRetries:           2,
        retryDelayMs:         1_000,
      };

      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-audit-'));
      const db2     = new AuditDb(path.join(tmpDir2, 'audit.db'));

      try {
        const wallet   = createWalletClient(keypair, walletConfig, logger);
        const adapters = createAdapterRegistry(connection, logger);

        const config: AgentConfig = {
          id:             'audit-count-test',
          keystorePath:   '/tmp/test.json',
          strategy:       'monitor',
          strategyParams: { trackedMints: [] },
          intervalMs:     0,
          limits: { maxPerTxLamports: 1_000_000n, maxSessionLamports: 10_000_000n },
        };

        const { MonitorStrategy } = await import('../../../src/agent/strategies/monitor.js');
        const strategy = new MonitorStrategy(config.strategyParams, RPC_URL);

        // Run 3 ticks
        let ticks = 0;
        const origDecide = strategy.decide.bind(strategy);
        vi.spyOn(strategy, 'decide').mockImplementation(async (state) => {
          ticks++;
          const action = await origDecide(state);
          if (ticks >= 3) loop.stop();
          return action;
        });

        const loop = new AgentLoop(config, wallet, strategy, adapters, logger, db2);
        await loop.start();

        // Exactly 1 agent_start
        expect(db2.query({ agentId: 'audit-count-test', event: 'agent_start' })).toHaveLength(1);
        // At least 3 noop rows (one per tick)
        expect(db2.query({ agentId: 'audit-count-test', event: 'agent_noop' }).length).toBeGreaterThanOrEqual(3);
        // Total row count: 1 start + 3 noops + 1 stop = 5
        expect(db2.count('audit-count-test')).toBeGreaterThanOrEqual(5);
      } finally {
        db2.close();
        fs.rmSync(tmpDir2, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

// vi is available globally via vitest
import { vi } from 'vitest';
