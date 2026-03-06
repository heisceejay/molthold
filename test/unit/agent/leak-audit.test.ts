import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { AgentLoop } from '../../../src/agent/loop.js';
import { UniversalStrategy } from '../../../src/agent/strategies/universal.js';
import { AuditDb } from '../../../src/logger/audit.js';
import pino from 'pino';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import type { AgentConfig } from '../../../src/agent/types.js';

describe('Secret leak audit (Phase 5.1)', () => {
    it('GATE: runs agent for 3 ticks and never leaks private key in logs or audit DB', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-leak-test-'));
        try {
            const dbPath = path.join(tmpDir, 'audit.db');
            const auditDb = new AuditDb(dbPath);

            // 1. Setup capturing logger
            const logLines: string[] = [];
            const stream = new Writable({
                write(chunk, _enc, cb) {
                    logLines.push(chunk.toString());
                    cb();
                }
            });
            const logger = pino({
                level: 'trace',
                redact: {
                    paths: [
                        'secretKey', 'secret_key', 'privateKey', 'private_key', 'keypair', 'seed', 'mnemonic',
                        '*.secretKey', '*.privateKey', '*.keypair', '*.seed'
                    ],
                    censor: '[REDACTED]'
                }
            }, stream);

            // 2. Setup wallet with a known secret key
            const keypair = Keypair.generate();
            const bs58 = await import('bs58');
            const actualSecretKeyBase58 = bs58.default.encode(keypair.secretKey);

            const { createWalletClient } = await import('../../../src/wallet/wallet.js');
            const wallet = createWalletClient(
                keypair,
                { rpcUrl: 'http://localhost', limits: { maxPerTxLamports: 100000000n, maxSessionLamports: 100000000n }, simulateBeforeSend: false, confirmationStrategy: 'confirmed', maxRetries: 0, retryDelayMs: 0 },
                logger
            );
            wallet.getSolBalance = async () => 500_000_000n;
            wallet.getTokenBalance = async () => 0n;

            // 3. Setup Universal strategy
            const { LLMDecider } = await import('../../../src/agent/strategies/llm.js');
            const llmDecider = new LLMDecider({
                maxPerTxLamports: 100000000n,
                maxSessionLamports: 100000000n
            });
            const strategy = new UniversalStrategy(llmDecider, 'http://localhost');

            // 3.1 Mock fetch for LLMDecider
            process.env['OPENROUTER_API_KEY'] = 'test-key';
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                type: 'swap',
                                params: {
                                    inputMint: 'So11111111111111111111111111111111111111112',
                                    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                                    amountIn: '10000000',
                                    slippageBps: 100,
                                    adapter: 'best'
                                },
                                rationale: 'Testing leak'
                            })
                        }
                    }]
                })
            }));

            // Mock adapters to avoid real network calls
            const mockAdapter = {
                name: 'mock',
                quote: async () => ({
                    inputMint: 'So11111111111111111111111111111111111111112',
                    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                    inAmount: 10000000n,
                    outAmount: 200000n,
                    otherAmountThreshold: 190000n,
                    priceImpactPct: 0.1,
                    provider: 'mock',
                    raw: {}
                }),
                swap: async () => ({
                    signature: 'mocksig123',
                    status: 'confirmed' as const,
                    inputMint: 'So11111111111111111111111111111111111111112',
                    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                    inAmount: 10000000n,
                    outAmount: 200000n,
                    quote: {} as any
                })
            };
            const adapters = new Map([['best', mockAdapter]]) as any;

            logger.info({ wallet, keypair }, 'Deliberate test log of sensitive objects');

            const config: AgentConfig = {
                id: 'audit-agent',
                keystorePath: 'unused',
                intervalMs: 1,
                limits: {
                    maxPerTxLamports: 100_000_000n,
                    maxSessionLamports: 1_000_000_000n,
                },
            };

            const loop = new AgentLoop(
                config,
                wallet as any,
                strategy,
                adapters,
                logger,
                auditDb
            );

            for (let i = 0; i < 3; i++) {
                await (loop as any).tick();
            }

            auditDb.close();

            expect(logLines.length).toBeGreaterThan(0);
            for (const line of logLines) {
                expect(line).not.toContain(actualSecretKeyBase58);
            }

            const Database = (await import('better-sqlite3')).default;
            const db = new Database(dbPath, { readonly: true });
            const rows = db.prepare('SELECT * FROM events').all() as any[];
            expect(rows.length).toBe(6);

            for (const row of rows) {
                expect(row.details_json).not.toContain(actualSecretKeyBase58);
                expect(row.details_json).not.toContain('secretKey');
            }
            db.close();

        } finally {
            vi.unstubAllGlobals();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
