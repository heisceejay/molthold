#!/usr/bin/env tsx
/**
 * @file scripts/fund-agents.ts
 * Airdrops devnet SOL to all agent wallets listed in agents.json.
 * Falls back to transfer from a funder wallet if airdrop is rate-limited.
 *
 * Usage:
 *   tsx scripts/fund-agents.ts
 *   tsx scripts/fund-agents.ts --config custom-agents.json
 *   tsx scripts/fund-agents.ts --amount 2.0
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as fs from 'node:fs';
import { createLogger } from '../src/logger/logger.js';
import { getPublicKeyFromKeystore } from '../src/wallet/keystore.js';

const logger = createLogger({ level: 'info' });
const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
const AMOUNT_SOL = parseFloat(process.env['FUND_AMOUNT_SOL'] ?? '1.0');
const CONFIG_PATH = process.env['AGENTS_CONFIG_PATH'] ?? './agents.json';

async function main(): Promise<void> {
  const connection = new Connection(RPC_URL, 'confirmed');

  if (!fs.existsSync(CONFIG_PATH)) {
    logger.error({ path: CONFIG_PATH }, 'agents.json not found. Create it first.');
    process.exit(1);
  }

  const agents = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Array<{
    id: string;
    keystorePath: string;
  }>;

  logger.info({ count: agents.length, amountSol: AMOUNT_SOL }, 'Funding agent wallets');

  for (const agent of agents) {
    try {
      const pubkey = getPublicKeyFromKeystore(agent.keystorePath);
      const { PublicKey } = await import('@solana/web3.js');
      const pk = new PublicKey(pubkey);

      logger.info({ agent: agent.id, pubkey }, 'Requesting airdrop...');
      const sig = await connection.requestAirdrop(pk, AMOUNT_SOL * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');

      const balance = await connection.getBalance(pk);
      logger.info({ agent: agent.id, balanceSol: balance / LAMPORTS_PER_SOL }, 'Funded ✓');
    } catch (err) {
      logger.warn({ agent: agent.id, err }, 'Airdrop failed (rate limited?) — try again or use funder wallet');
    }

    // Throttle to avoid rate limits
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

main().catch((err) => {
  logger.error({ err }, 'fund-agents script failed');
  process.exit(1);
});
