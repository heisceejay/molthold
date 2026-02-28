/**
 * @file src/cli/output.ts
 *
 * Typed output helpers for all CLI commands.
 * Keeps presentation logic out of command files.
 *
 * Rules:
 *  - Never import WalletClient — only accepts plain strings/numbers/bigints
 *  - All stdout is human-readable; stderr is used for errors
 *  - Exit codes: 0 success, 1 user error, 2 internal/unexpected error
 */

import * as readline from 'node:readline';

// ── Colours (ANSI, disabled when not a TTY or CI=true) ───────────────────────

const NO_COLOR = !process.stdout.isTTY || process.env['CI'] === 'true' || process.env['NO_COLOR'];

const c = {
  bold:   (s: string): string => NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`,
  green:  (s: string): string => NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string): string => NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`,
  red:    (s: string): string => NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`,
  cyan:   (s: string): string => NO_COLOR ? s : `\x1b[36m${s}\x1b[0m`,
  dim:    (s: string): string => NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`,
};

// ── Section headers ───────────────────────────────────────────────────────────

export function header(title: string): void {
  const line = '─'.repeat(Math.min(title.length + 4, 60));
  process.stdout.write(`\n${c.bold(line)}\n  ${c.bold(title)}\n${c.bold(line)}\n\n`);
}

export function subheader(text: string): void {
  process.stdout.write(`\n${c.dim('▸')} ${c.bold(text)}\n`);
}

// ── Status lines ──────────────────────────────────────────────────────────────

export function success(msg: string): void {
  process.stdout.write(`${c.green('✓')} ${msg}\n`);
}

export function warn(msg: string): void {
  process.stdout.write(`${c.yellow('⚠')} ${msg}\n`);
}

export function info(msg: string): void {
  process.stdout.write(`  ${c.dim('·')} ${msg}\n`);
}

export function printLine(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

// ── Error output ─────────────────────────────────────────────────────────────

export function errorAndExit(msg: string, code = 1): never {
  process.stderr.write(`\n${c.red('✗ Error:')} ${msg}\n\n`);
  process.exit(code);
}

export function fatalError(err: unknown, context?: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as Record<string, unknown>)['code'];
  const codeStr = code ? ` [${code}]` : '';
  const ctx = context ? `${context}: ` : '';
  process.stderr.write(`\n${c.red('✗')} ${ctx}${msg}${codeStr}\n\n`);
  process.exit(1);
}

// ── Key-value pairs ───────────────────────────────────────────────────────────

export function kv(pairs: Array<[string, string]>): void {
  const maxKey = Math.max(...pairs.map(([k]) => k.length));
  for (const [key, val] of pairs) {
    process.stdout.write(`  ${c.dim(key.padEnd(maxKey, ' '))}  ${val}\n`);
  }
}

// ── Tables ────────────────────────────────────────────────────────────────────

export function table(
  headers: string[],
  rows: string[][],
  opts: { maxWidth?: number } = {},
): void {
  if (rows.length === 0) {
    process.stdout.write(`  ${c.dim('(no rows)')}\n`);
    return;
  }

  const maxWidth = opts.maxWidth ?? 120;
  const colWidths = headers.map((h, i) =>
    Math.min(
      maxWidth / headers.length,
      Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
    ),
  );

  const headerLine = headers
    .map((h, i) => c.bold(h.padEnd(colWidths[i] ?? 0)))
    .join('  ');

  const separator = colWidths.map((w) => '─'.repeat(w)).join('  ');

  process.stdout.write(`  ${headerLine}\n`);
  process.stdout.write(`  ${c.dim(separator)}\n`);

  for (const row of rows) {
    const line = row.map((cell, i) => {
      const w   = colWidths[i] ?? 0;
      const str = (cell ?? '').slice(0, w);
      return str.padEnd(w);
    }).join('  ');
    process.stdout.write(`  ${line}\n`);
  }
}

// ── SOL / lamport formatting ──────────────────────────────────────────────────

export function lamportsToSol(lamports: bigint, decimals = 6): string {
  const sol = Number(lamports) / 1_000_000_000;
  return sol.toFixed(decimals);
}

export function formatBalance(lamports: bigint): string {
  return `${c.cyan(lamportsToSol(lamports))} SOL  ${c.dim(`(${lamports.toLocaleString()} lamports)`)}`;
}

export function formatTokenBalance(amount: bigint, decimals: number, symbol?: string): string {
  const n = Number(amount) / 10 ** decimals;
  const sym = symbol ? ` ${symbol}` : '';
  return `${c.cyan(n.toFixed(decimals))}${sym}`;
}

// ── Spinner (for long async ops) ──────────────────────────────────────────────

const SPIN_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  stop(finalMsg?: string): void;
}

export function spinner(msg: string): Spinner {
  if (!process.stdout.isTTY) {
    process.stdout.write(`  ${msg}...\n`);
    return { stop: (m) => { if (m) process.stdout.write(`  ${m}\n`); } };
  }

  let i = 0;
  const timer = setInterval(() => {
    const char = SPIN_CHARS[i % SPIN_CHARS.length]!;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`  ${c.cyan(char)} ${msg}`);
    i++;
  }, 80);

  return {
    stop(finalMsg?: string): void {
      clearInterval(timer);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      if (finalMsg) process.stdout.write(`  ${finalMsg}\n`);
    },
  };
}

// ── Password prompt ───────────────────────────────────────────────────────────

export function promptPassword(prompt = 'Wallet password: '): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });

    // Hide input
    const muted = rl as unknown as { _writeToOutput: (s: string) => void };
    muted._writeToOutput = (s: string) => {
      if (s.charCodeAt(0) === 13) { // carriage return — show newline
        process.stdout.write('\n');
      }
      // suppress all other characters (hidden input)
    };

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── Audit row formatter ───────────────────────────────────────────────────────

import type { AuditRow } from '../logger/audit.js';

export function formatAuditRows(rows: AuditRow[]): void {
  if (rows.length === 0) {
    process.stdout.write(`  ${c.dim('No audit events found.')}\n`);
    return;
  }

  for (const row of rows) {
    const ts  = new Date(row.ts).toLocaleString();
    const sig = row.signature
      ? `  ${c.dim('sig:')} ${row.signature.slice(0, 16)}…`
      : '';
    const status = row.status
      ? ` ${row.status === 'confirmed' ? c.green(row.status) : c.yellow(row.status)}`
      : '';

    process.stdout.write(
      `  ${c.dim(ts)}  ${c.bold(row.event.padEnd(14))}${status}${sig}\n`,
    );

    // Show key details from details_json inline
    try {
      const details = JSON.parse(row.details_json) as Record<string, unknown>;
      const interesting = ['action', 'rationale', 'error', 'code', 'tick', 'solBalance']
        .filter((k) => k in details)
        .map((k) => `${k}=${String(details[k])}`)
        .join('  ');
      if (interesting) {
        process.stdout.write(`    ${c.dim(interesting)}\n`);
      }
    } catch {
      // malformed JSON — skip detail line
    }
  }
}

// Re-export colour helper for commands that need it
export { c };
