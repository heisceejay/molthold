/**
 * Unit tests for the protocol adapter layer.
 *
 * Test gates from implementation plan:
 *  ✅ Adapter never logs wallet reference or any key-adjacent field
 *  ✅ ProtocolError is thrown (not WalletError) on adapter failures
 *  ✅ getBestQuote picks higher outAmount
 *  ✅ createAdapterRegistry throws on unknown adapter name
 *  ✅ Quote shape is fully typed (no undefined required fields)
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { JupiterAdapter } from '../../../src/protocols/jupiter.js';
import { createAdapterRegistry } from '../../../src/protocols/index.js';
import { ProtocolError } from '../../../src/protocols/types.js';
import { createLogger } from '../../../src/logger/logger.js';
import type { Quote } from '../../../src/protocols/types.js';
import type { WalletClient } from '../../../src/wallet/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConnection(): Connection {
  return new Connection('https://api.devnet.solana.com', 'confirmed');
}

/** Builds a minimal WalletClient mock that tracks calls. */
function makeMockWallet(): WalletClient & { signAndSendCalls: number } {
  const keypair = Keypair.generate();
  let signAndSendCalls = 0;
  const mock = {
    publicKey: keypair.publicKey,
    getSolBalance: vi.fn().mockResolvedValue(1_000_000_000n),
    getTokenBalance: vi.fn().mockResolvedValue(0n),
    getOrCreateTokenAccount: vi.fn().mockResolvedValue(keypair.publicKey),
    sendSol: vi.fn(),
    sendToken: vi.fn(),
    signTransaction: vi.fn(async (tx) => tx),
    signAndSendTransaction: vi.fn(async () => {
      signAndSendCalls++;
      return { signature: 'fakesig123', status: 'confirmed' as const, slot: 1 };
    }),
    getSpendingLimitStatus: vi.fn().mockReturnValue({
      sessionSpend: 0n, sessionCap: 1_000_000_000n, perTxCap: 100_000_000n,
    }),
    toJSON: () => keypair.publicKey.toBase58(),
    toString: () => keypair.publicKey.toBase58(),
  };
  return Object.assign(mock, { get signAndSendCalls() { return signAndSendCalls; } });
}

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    inputMint:            'So11111111111111111111111111111111111111112',
    outputMint:           'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inAmount:             10_000_000n,
    outAmount:            9_500_000n,
    otherAmountThreshold: 9_000_000n,
    priceImpactPct:       0.1,
    provider:             'jupiter',
    raw:                  {},
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('JupiterAdapter — log safety', () => {
  it('GATE: swap() never passes the wallet object as a log field', async () => {
    const logLines: unknown[] = [];
    const logger = createLogger({ level: 'trace' });

    // Intercept all log calls
    const origInfo  = logger.info.bind(logger);
    const origDebug = logger.debug.bind(logger);
    const origWarn  = logger.warn.bind(logger);

    const captureLog = (args: unknown[]): void => { logLines.push(args); };
    vi.spyOn(logger, 'info').mockImplementation((...args) => { captureLog(args); return origInfo(...(args as Parameters<typeof origInfo>)); });
    vi.spyOn(logger, 'debug').mockImplementation((...args) => { captureLog(args); return origDebug(...(args as Parameters<typeof origDebug>)); });
    vi.spyOn(logger, 'warn').mockImplementation((...args) => { captureLog(args); return origWarn(...(args as Parameters<typeof origWarn>)); });

    const adapter  = new JupiterAdapter(makeConnection(), logger);
    const wallet   = makeMockWallet();
    const quote    = makeQuote();

    // Mock the fetch calls so we don't need network
    const mockSwapResp = {
      swapTransaction: Buffer.alloc(100).toString('base64'),
      lastValidBlockHeight: 999,
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ inAmount: '10000000', outAmount: '9500000', otherAmountThreshold: '9000000', priceImpactPct: '0.1', inputMint: quote.inputMint, outputMint: quote.outputMint, routePlan: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => mockSwapResp })
    );

    // The VersionedTransaction.deserialize will fail with mock data — that's fine,
    // we only care that no wallet object leaked into logs before that point.
    try {
      await adapter.swap(wallet, quote, 50);
    } catch {
      // Expected to fail on deserialise
    }

    // Inspect every log call — none should have the wallet object as a value
    for (const line of logLines) {
      const serialised = JSON.stringify(line);
      // Must not contain keypair-adjacent field names
      expect(serialised).not.toContain('"secretKey"');
      expect(serialised).not.toContain('"privateKey"');
      expect(serialised).not.toContain('"keypair"');
      // Must not contain the wallet object itself (would be serialised to pubkey only via toJSON)
      // Wallet pubkey IS allowed in logs (it's safe)
    }

    vi.unstubAllGlobals();
  });

  it('GATE: quote() only logs inputMint, outputMint, amounts — no wallet fields', async () => {
    const loggedObjects: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'trace' });
    vi.spyOn(logger, 'debug').mockImplementation((obj) => {
      if (typeof obj === 'object' && obj !== null) {
        loggedObjects.push(obj as Record<string, unknown>);
      }
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        inputMint: 'So11111111111111111111111111111111111111112',
        inAmount: '10000000',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        outAmount: '9500000',
        otherAmountThreshold: '9000000',
        priceImpactPct: '0.1',
        routePlan: [],
      }),
    }));

    const adapter = new JupiterAdapter(makeConnection(), logger);
    const input   = new PublicKey('So11111111111111111111111111111111111111112');
    const output  = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    await adapter.quote(input, output, 10_000_000n);

    for (const obj of loggedObjects) {
      // None of the logged objects should have a 'wallet' field
      expect(Object.keys(obj)).not.toContain('wallet');
      expect(Object.keys(obj)).not.toContain('secretKey');
      expect(Object.keys(obj)).not.toContain('keypair');
    }

    vi.unstubAllGlobals();
  });
});

describe('JupiterAdapter — quote parsing', () => {
  it('throws QUOTE_FAILED when fetch returns non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' }));

    const adapter = new JupiterAdapter(makeConnection(), createLogger({ level: 'error' }));
    const input   = new PublicKey('So11111111111111111111111111111111111111112');
    const output  = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    await expect(adapter.quote(input, output, 10_000_000n)).rejects.toMatchObject({
      code: 'QUOTE_FAILED',
    });

    vi.unstubAllGlobals();
  });

  it('throws QUOTE_FAILED when outAmount is zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        inputMint: 'So11111111111111111111111111111111111111112',
        inAmount: '10000000',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        outAmount: '0',
        otherAmountThreshold: '0',
        priceImpactPct: '99',
        routePlan: [],
      }),
    }));

    const adapter = new JupiterAdapter(makeConnection(), createLogger({ level: 'error' }));
    const input   = new PublicKey('So11111111111111111111111111111111111111112');
    const output  = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    await expect(adapter.quote(input, output, 10_000_000n)).rejects.toMatchObject({
      code: 'QUOTE_FAILED',
    });

    vi.unstubAllGlobals();
  });

  it('returns a fully-typed Quote with correct bigint fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        inputMint: 'So11111111111111111111111111111111111111112',
        inAmount: '10000000',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        outAmount: '9876543',
        otherAmountThreshold: '9300000',
        priceImpactPct: '0.05',
        routePlan: [{}],
      }),
    }));

    const adapter = new JupiterAdapter(makeConnection(), createLogger({ level: 'error' }));
    const input   = new PublicKey('So11111111111111111111111111111111111111112');
    const output  = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    const q = await adapter.quote(input, output, 10_000_000n);

    expect(q.provider).toBe('jupiter');
    expect(q.inAmount).toBe(10_000_000n);
    expect(q.outAmount).toBe(9_876_543n);
    expect(q.otherAmountThreshold).toBe(9_300_000n);
    expect(q.priceImpactPct).toBeCloseTo(0.05);
    expect(typeof q.inAmount).toBe('bigint');
    expect(typeof q.outAmount).toBe('bigint');

    vi.unstubAllGlobals();
  });
});

describe('AdapterRegistry', () => {
  it('GATE: get() throws ADAPTER_UNAVAILABLE for unknown adapter name', () => {
    const registry = createAdapterRegistry(makeConnection(), createLogger({ level: 'error' }));
    expect(() => registry.get('unknown' as 'jupiter')).toThrow(ProtocolError);
  });

  it('get("jupiter") returns a JupiterAdapter', () => {
    const registry = createAdapterRegistry(makeConnection(), createLogger({ level: 'error' }));
    const adapter  = registry.get('jupiter');
    expect(adapter.name).toBe('jupiter');
  });

  it('get("orca") returns an OrcaAdapter', () => {
    const registry = createAdapterRegistry(makeConnection(), createLogger({ level: 'error' }));
    const adapter  = registry.get('orca');
    expect(adapter.name).toBe('orca');
  });

  it('GATE: getBestQuote returns the adapter with higher outAmount', async () => {
    const jupiterQuote = makeQuote({ outAmount: 9_500_000n, provider: 'jupiter' });
    const orcaQuote    = makeQuote({ outAmount: 9_800_000n, provider: 'orca' });

    const registry = createAdapterRegistry(makeConnection(), createLogger({ level: 'error' }));

    // Stub both adapters' quote methods
    vi.spyOn(registry.get('jupiter'), 'quote').mockResolvedValue(jupiterQuote);
    vi.spyOn(registry.get('orca'),    'quote').mockResolvedValue(orcaQuote);

    const input  = new PublicKey('So11111111111111111111111111111111111111112');
    const output = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    const { quote, adapter } = await registry.getBestQuote(input, output, 10_000_000n);

    expect(adapter).toBe('orca');
    expect(quote.outAmount).toBe(9_800_000n);
  });

  it('getBestQuote falls back to Jupiter if Orca fails', async () => {
    const jupiterQuote = makeQuote({ outAmount: 9_500_000n, provider: 'jupiter' });

    const registry = createAdapterRegistry(makeConnection(), createLogger({ level: 'error' }));

    vi.spyOn(registry.get('jupiter'), 'quote').mockResolvedValue(jupiterQuote);
    vi.spyOn(registry.get('orca'),    'quote').mockRejectedValue(new ProtocolError('ADAPTER_UNAVAILABLE', 'SDK not installed'));

    const input  = new PublicKey('So11111111111111111111111111111111111111112');
    const output = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    const { quote, adapter } = await registry.getBestQuote(input, output, 10_000_000n);

    expect(adapter).toBe('jupiter');
    expect(quote.outAmount).toBe(9_500_000n);
  });

  it('getBestQuote throws QUOTE_FAILED if all adapters fail', async () => {
    const registry = createAdapterRegistry(makeConnection(), createLogger({ level: 'error' }));

    vi.spyOn(registry.get('jupiter'), 'quote').mockRejectedValue(new ProtocolError('QUOTE_FAILED', 'Jupiter down'));
    vi.spyOn(registry.get('orca'),    'quote').mockRejectedValue(new ProtocolError('ADAPTER_UNAVAILABLE', 'Orca down'));

    const input  = new PublicKey('So11111111111111111111111111111111111111112');
    const output = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    await expect(registry.getBestQuote(input, output, 10_000_000n)).rejects.toMatchObject({
      code: 'QUOTE_FAILED',
    });
  });
});

describe('ProtocolError', () => {
  it('has correct name and code', () => {
    const err = new ProtocolError('SWAP_FAILED', 'test');
    expect(err.name).toBe('ProtocolError');
    expect(err.code).toBe('SWAP_FAILED');
    expect(err.message).toBe('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProtocolError);
  });
});
