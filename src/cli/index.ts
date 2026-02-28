#!/usr/bin/env node
/**
 * @file src/cli/index.ts
 *
 * Molthold CLI entry point.
 *
 * Usage:
 *   agentw wallet create  --name alice
 *   agentw wallet balance --name alice
 *   agentw wallet airdrop --name alice
 *   agentw wallet transfer --name alice --to <pubkey> --amount 5000000
 *   agentw wallet list
 *
 *   agentw agent start  --config agents.json
 *   agentw agent start  --name alice --strategy dca
 *   agentw agent status [--name alice]
 *   agentw agent log    --name alice [--last 50]
 *
 * Run with:
 *   npx tsx src/cli/index.ts <command>
 *   # or after build:
 *   node dist/cli/index.js <command>
 */

import { Command } from 'commander';
import { walletCommand } from './commands/wallet.js';
import { agentCommand } from './commands/agent.js';
import { dashboardCommand } from './commands/dashboard.js';

const program = new Command()
  .name('agentw')
  .description('Molthold — Autonomous AI-agent wallet for Solana')
  .version('1.0.0', '-v, --version', 'Print version number')
  .helpOption('-h, --help', 'Show help')
  // Surface errors instead of swallowing them
  .showHelpAfterError(true)
  .configureOutput({
    // Write commander errors to stderr
    outputError: (str, write) => write(`\n\x1b[31m✗\x1b[0m ${str.trim()}\n\n`),
  });

program.addCommand(walletCommand);
program.addCommand(agentCommand);
program.addCommand(dashboardCommand);

// Catch unhandled top-level errors (e.g. missing subcommand)
program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n\x1b[31m✗ Fatal:\x1b[0m ${msg}\n\n`);
  process.exit(2);
});
