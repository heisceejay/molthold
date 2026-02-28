/**
 * @file src/protocols/index.ts
 *
 * Adapter registry — the single entry point for the agent layer into all
 * protocol adapters.
 *
 * Usage:
 *   const adapters = createAdapterRegistry(connection, logger);
 *   const { quote, adapter } = await adapters.getBestQuote(input, output, amount);
 *   const result = await adapters.get(adapter).swap(wallet, quote, 50);
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { JupiterAdapter } from './jupiter.js';
import { OrcaAdapter } from './orca.js';
import { ProtocolError, type AdapterName, type AdapterRegistry, type Quote, type SwapAdapter } from './types.js';
import type { Logger } from '../logger/logger.js';

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates and returns an AdapterRegistry pre-populated with all supported adapters.
 * Adapters are instantiated once and reused — they hold no per-wallet state.
 */
export function createAdapterRegistry(
  connection: Connection,
  logger: Logger,
): AdapterRegistry {
  const adapters = new Map<AdapterName, SwapAdapter>([
    ['jupiter', new JupiterAdapter(connection, logger)],
    ['orca',    new OrcaAdapter(connection, logger)],
  ]);

  return {
    get(name: AdapterName): SwapAdapter {
      const adapter = adapters.get(name);
      if (!adapter) {
        throw new ProtocolError('ADAPTER_UNAVAILABLE', `Unknown adapter: ${name}`);
      }
      return adapter;
    },

    /**
     * Races both adapters for a quote and returns the one with the higher
     * outAmount. Falls back to Jupiter alone if Orca quote fails (SDK not
     * installed, pool not found, etc.).
     */
    async getBestQuote(
      input: PublicKey,
      output: PublicKey,
      amountIn: bigint,
    ): Promise<{ quote: Quote; adapter: AdapterName }> {
      const results = await Promise.allSettled([
        adapters.get('jupiter')!.quote(input, output, amountIn).then((q) => ({ q, name: 'jupiter' as AdapterName })),
        adapters.get('orca')!.quote(input, output, amountIn).then((q) => ({ q, name: 'orca' as AdapterName })),
      ]);

      const successes = results
        .filter((r): r is PromiseFulfilledResult<{ q: Quote; name: AdapterName }> => r.status === 'fulfilled')
        .map((r) => r.value);

      if (successes.length === 0) {
        const errs = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => String(r.reason))
          .join('; ');
        throw new ProtocolError('QUOTE_FAILED', `All adapters failed to quote: ${errs}`);
      }

      // Return the quote with the highest outAmount
      const best = successes.reduce((a, b) => (a.q.outAmount >= b.q.outAmount ? a : b));

      logger.debug({
        adapter: best.name,
        outAmount: best.q.outAmount.toString(),
        inputMint: input.toBase58(),
        outputMint: output.toBase58(),
      }, 'getBestQuote: selected adapter');

      return { quote: best.q, adapter: best.name };
    },
  };
}

// ── Named convenience function ────────────────────────────────────────────────

/**
 * Returns a single named adapter. Useful when the agent strategy has a
 * hard preference (e.g. always use Jupiter).
 */
export function getSwapAdapter(
  name: AdapterName,
  connection: Connection,
  logger: Logger,
): SwapAdapter {
  return createAdapterRegistry(connection, logger).get(name);
}

// Re-export all types for convenience
export type { AdapterName, AdapterRegistry, Quote, SwapAdapter, SwapResult, ProtocolError } from './types.js';
export { ProtocolError as ProtocolErr } from './types.js';
export { JupiterAdapter } from './jupiter.js';
export { OrcaAdapter } from './orca.js';
export { accountExists, getTokenPrice, getTokenPrices, getPoolReserves } from './rpc.js';
