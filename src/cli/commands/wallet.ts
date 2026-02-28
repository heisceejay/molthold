/**
 * @file src/cli/commands/wallet.ts
 *
 * Wallet subcommand group:
 *
 *   agentw wallet create  --name <id> [--password <pass>]
 *   agentw wallet balance --name <id> [--password <pass>]
 *   agentw wallet airdrop --name <id> [--amount <sol>]
 *   agentw wallet transfer --name <id> --to <pubkey> --amount <lamports>
 *   agentw wallet list
 *
 * Password resolution order (highest priority first):
 *   1. --password flag
 *   2. WALLET_PASSWORD env var
 *   3. Interactive prompt (TTY only)
 *
 * SECURITY: This file never touches a Keypair directly after construction.
 * It always delegates to WalletClient methods.
 */

import { Command } from 'commander';
import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { env, spendingLimits } from '../../config/env.js';
import { createKeystore, loadKeystore, getPublicKeyFromKeystore } from '../../wallet/keystore.js';
import { createWalletClient } from '../../wallet/wallet.js';
import { WalletError } from '../../wallet/types.js';
import { createLogger } from '../../logger/logger.js';
import {
  header, success, info, kv, formatBalance, errorAndExit, fatalError,
  spinner, promptPassword, table, printLine,
} from '../output.js';

// ── Keystore directory ────────────────────────────────────────────────────────

const KEYSTORES_DIR = path.resolve(process.cwd(), 'keystores');

function keystorePath(name: string): string {
  return path.join(KEYSTORES_DIR, `${name}.keystore.json`);
}

// ── Password resolution ───────────────────────────────────────────────────────

async function resolvePassword(flagPassword?: string, promptMsg = 'Wallet password: '): Promise<string> {
  if (flagPassword) return flagPassword;
  if (env.WALLET_PASSWORD) return env.WALLET_PASSWORD;

  if (!process.stdin.isTTY) {
    errorAndExit(
      'No password provided. Set --password, WALLET_PASSWORD env var, or run interactively.',
    );
  }

  return promptPassword(promptMsg);
}

// ── Shared wallet builder ─────────────────────────────────────────────────────

function loadWallet(name: string, password: string) {
  const kpPath = keystorePath(name);
  if (!fs.existsSync(kpPath)) {
    errorAndExit(`Wallet "${name}" not found. Run: agentw wallet create --name ${name}`);
  }

  const logger = createLogger({ level: 'warn' }); // suppress RPC noise in CLI
  let keypair: Keypair;
  try {
    keypair = loadKeystore(kpPath, password);
  } catch (err) {
    if (err instanceof WalletError && err.code === 'INVALID_KEYSTORE') {
      errorAndExit('Wrong password or corrupted keystore.');
    }
    fatalError(err, 'loadWallet');
  }

  const wallet = createWalletClient(keypair!, {
    rpcUrl: env.SOLANA_RPC_URL,
    limits: spendingLimits,
    simulateBeforeSend: true,
    confirmationStrategy: 'confirmed',
    maxRetries: 3,
    retryDelayMs: 2_000,
  }, logger);

  return wallet;
}

// ── wallet create ─────────────────────────────────────────────────────────────

const createCmd = new Command('create')
  .description('Generate a new wallet and save it as an encrypted keystore')
  .requiredOption('--name <id>', 'Unique identifier for this wallet')
  .option('--password <pass>', 'Encryption password (min 8 chars)')
  .action(async (opts: { name: string; password?: string }) => {
    const { name } = opts;

    if (!/^[\w-]+$/.test(name)) {
      errorAndExit('Wallet name may only contain letters, numbers, hyphens, and underscores.');
    }

    const kpPath = keystorePath(name);
    if (fs.existsSync(kpPath)) {
      errorAndExit(`Wallet "${name}" already exists at ${kpPath}. Choose a different name or delete the existing file.`);
    }

    const password = await resolvePassword(
      opts.password,
      'New wallet password (min 8 chars): ',
    );

    if (password.length < 8) {
      errorAndExit('Password must be at least 8 characters.');
    }

    header(`Creating wallet: ${name}`);

    const spin = spinner('Generating keypair and encrypting keystore…');

    fs.mkdirSync(KEYSTORES_DIR, { recursive: true });
    const keypair = Keypair.generate();
    const keystore = createKeystore(keypair, password, kpPath);
    spin.stop();

    success(`Keystore saved to ${kpPath}`);
    printLine('');
    kv([
      ['Name', name],
      ['Public key', keystore.publicKey],
      ['File', kpPath],
      ['Encryption', 'AES-256-GCM / scrypt'],
    ]);
    printLine('');
    info('Fund this wallet with: agentw wallet airdrop --name ' + name);
    info('IMPORTANT: Remember your password — it cannot be recovered.');
    printLine('');
  });

// ── wallet balance ────────────────────────────────────────────────────────────

const balanceCmd = new Command('balance')
  .description('Show SOL balance and spending limit status')
  .requiredOption('--name <id>', 'Wallet identifier')
  .option('--password <pass>', 'Decryption password')
  .action(async (opts: { name: string; password?: string }) => {
    const password = await resolvePassword(opts.password);
    const wallet = loadWallet(opts.name, password);

    header(`Balance: ${opts.name}`);

    const spin = spinner('Fetching on-chain balance…');
    let balance: bigint;
    try {
      balance = await wallet.getSolBalance();
    } catch (err) {
      spin.stop();
      fatalError(err, 'getSolBalance');
    }
    spin.stop();

    const limits = wallet.getSpendingLimitStatus();

    kv([
      ['Wallet', opts.name],
      ['Public key', wallet.publicKey.toBase58()],
      ['SOL balance', formatBalance(balance!)],
      ['Per-tx cap', formatBalance(limits.perTxCap)],
      ['Session spent', formatBalance(limits.sessionSpend)],
      ['Session cap', formatBalance(limits.sessionCap)],
    ]);
    printLine('');
  });

// ── wallet airdrop ────────────────────────────────────────────────────────────

const airdropCmd = new Command('airdrop')
  .description('Request a devnet SOL airdrop (devnet only)')
  .requiredOption('--name <id>', 'Wallet identifier')
  .option('--amount <sol>', 'SOL to request (default: 1)', '1')
  .action(async (opts: { name: string; amount: string }) => {
    if (env.SOLANA_NETWORK !== 'devnet' && env.SOLANA_NETWORK !== 'testnet' && env.SOLANA_NETWORK !== 'localnet') {
      errorAndExit('Airdrop is only available on devnet, testnet, and localnet.');
    }

    const kpPath = keystorePath(opts.name);
    if (!fs.existsSync(kpPath)) {
      errorAndExit(`Wallet "${opts.name}" not found. Run: agentw wallet create --name ${opts.name}`);
    }

    const amountSol = parseFloat(opts.amount);
    if (isNaN(amountSol) || amountSol <= 0 || amountSol > 2) {
      errorAndExit('Airdrop amount must be between 0 and 2 SOL (devnet limit).');
    }

    const pubkey = getPublicKeyFromKeystore(kpPath);

    header(`Airdrop → ${opts.name}`);

    kv([
      ['Wallet', opts.name],
      ['Public key', pubkey],
      ['Amount', `${amountSol} SOL`],
      ['Network', env.SOLANA_NETWORK],
    ]);
    printLine('');

    const spin = spinner(`Requesting ${amountSol} SOL airdrop…`);
    const conn = new Connection(env.SOLANA_RPC_URL, 'confirmed');
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

    try {
      const sig = await conn.requestAirdrop(new PublicKey(pubkey), lamports);

      // Wait for confirmation
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

      spin.stop();
      success(`Airdrop confirmed!`);
      kv([
        ['Signature', sig],
        ['Amount', `${amountSol} SOL`],
      ]);
      printLine('');
    } catch (err) {
      spin.stop();
      fatalError(err, 'airdrop');
    }
  });

// ── wallet transfer ───────────────────────────────────────────────────────────

const transferCmd = new Command('transfer')
  .description('Send SOL to another address')
  .requiredOption('--name <id>', 'Source wallet identifier')
  .requiredOption('--to <pubkey>', 'Destination public key (base58)')
  .requiredOption('--amount <amount>', 'Amount in lamports (integer) or SOL if --sol flag set')
  .option('--sol', 'Treat --amount as SOL rather than lamports')
  .option('--password <pass>', 'Decryption password')
  .action(async (opts: { name: string; to: string; amount: string; sol?: boolean; password?: string }) => {
    // Validate destination public key
    let destPubkey: PublicKey;
    try {
      destPubkey = new PublicKey(opts.to);
    } catch {
      errorAndExit(`Invalid destination public key: ${opts.to}`);
    }

    // Parse amount
    const rawAmt = parseFloat(opts.amount);
    if (isNaN(rawAmt) || rawAmt <= 0) {
      errorAndExit('--amount must be a positive number.');
    }
    const lamports = opts.sol
      ? BigInt(Math.round(rawAmt * LAMPORTS_PER_SOL))
      : BigInt(Math.round(rawAmt));

    if (lamports < 1n) {
      errorAndExit('Transfer amount must be at least 1 lamport.');
    }

    const password = await resolvePassword(opts.password);
    const wallet = loadWallet(opts.name, password);

    header(`Transfer: ${opts.name} → ${opts.to.slice(0, 12)}…`);

    kv([
      ['From', wallet.publicKey.toBase58()],
      ['To', destPubkey!.toBase58()],
      ['Amount', formatBalance(lamports)],
      ['Network', env.SOLANA_NETWORK],
    ]);
    printLine('');

    const spin = spinner('Signing and sending transaction…');
    try {
      const result = await wallet.sendSol(destPubkey!, lamports);
      spin.stop();

      if (result.status === 'confirmed') {
        success('Transfer confirmed!');
        kv([
          ['Signature', result.signature ?? 'n/a'],
          ['Slot', String(result.slot ?? 'n/a')],
        ]);
      } else {
        printLine(`Status: ${result.status}`);
        if (result.error) info(`Error: ${result.error}`);
      }
    } catch (err) {
      spin.stop();
      if (err instanceof WalletError && err.code === 'LIMIT_BREACH') {
        errorAndExit(`Transaction rejected by spending limit: ${err.message}`);
      }
      fatalError(err, 'transfer');
    }
    printLine('');
  });

// ── wallet list ───────────────────────────────────────────────────────────────

const listCmd = new Command('list')
  .description('List all wallet keystores in the keystores/ directory')
  .action(() => {
    header('Wallets');

    if (!fs.existsSync(KEYSTORES_DIR)) {
      info('No keystores directory found. Create a wallet with: agentw wallet create --name <id>');
      printLine('');
      return;
    }

    const files = fs.readdirSync(KEYSTORES_DIR)
      .filter((f) => f.endsWith('.keystore.json'));

    if (files.length === 0) {
      info('No wallets found. Create one with: agentw wallet create --name <id>');
      printLine('');
      return;
    }

    const rows = files.map((f) => {
      const name = f.replace('.keystore.json', '');
      const full = path.join(KEYSTORES_DIR, f);
      const stat = fs.statSync(full);
      let pubkey = 'unknown';
      try {
        pubkey = getPublicKeyFromKeystore(full);
      } catch { /* skip */ }

      return [
        name,
        pubkey,
        stat.mtime.toLocaleDateString(),
        `${(stat.size / 1024).toFixed(1)} KB`,
      ];
    });

    table(['Name', 'Public Key', 'Modified', 'Size'], rows);
    printLine('');
  });

// ── wallet command group ──────────────────────────────────────────────────────

export const walletCommand = new Command('wallet')
  .description('Manage wallet keystores')
  .addCommand(createCmd)
  .addCommand(balanceCmd)
  .addCommand(airdropCmd)
  .addCommand(transferCmd)
  .addCommand(listCmd);
