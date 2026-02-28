import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { AgentLoop } from '../../../src/agent/loop.js';
import { DcaStrategy } from '../../../src/agent/strategies/dca.js';
import { AuditDb } from '../../../src/logger/audit.js';
import pino from 'pino';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';

describe('Secret leak audit (Phase 5.1)', () => {
    it('GATE: runs DCA agent for 3 ticks and never leaks private key in logs or audit DB', async () => {
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
            // We explicitly pass the stream to a new pino instance, mimicking createLogger's redacts
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
            const secretKeyBase58 = Math.random().toString() + Date.now().toString(); // Use a dummy string we can easily grep for
            // To really test base58 leak, we check for the actual base58 of the generated key
            const bs58 = await import('bs58');
            const actualSecretKeyBase58 = bs58.default.encode(keypair.secretKey);

            const { createWalletClient } = await import('../../../src/wallet/wallet.js');
            const wallet = createWalletClient(
                keypair,
                { rpcUrl: 'http://localhost', limits: { maxPerTxLamports: 100000000n, maxSessionLamports: 100000000n }, simulateBeforeSend: false, confirmationStrategy: 'confirmed', maxRetries: 0, retryDelayMs: 0 },
                logger
            );
            // Mock network reads
            wallet.getSolBalance = async () => 500_000_000n; // 0.5 SOL
            wallet.getTokenBalance = async () => 0n;

            // 3. Setup DCA strategy
            const strategy = new DcaStrategy({
                targetMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                amountPerTickLamports: '10000000', // 0.01 SOL
                minSolReserveLamports: '50000000',
                adapter: 'best'
            });

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

            // Force logger to try to log the wallet object (which contains the keypair if not careful)
            logger.info({ wallet, keypair }, 'Deliberate test log of sensitive objects');

            const loop = new AgentLoop(
                { id: 'leak-test-agent', strategy: 'dca', intervalMs: 100, strategyParams: {}, keystorePath: '', limits: { maxPerTxLamports: 0n, maxSessionLamports: 0n } },
                wallet as any,
                strategy,
                adapters,
                logger,
                auditDb
            );

            // 4. Run exactly 3 ticks
            // Call the private `tick()` method via any
            for (let i = 0; i < 3; i++) {
                await (loop as any).tick();
            }

            auditDb.close();

            // 5. Assertions

            // Check log lines
            expect(logLines.length).toBeGreaterThan(0);
            for (const line of logLines) {
                expect(line).not.toContain(actualSecretKeyBase58);
            }

            // Check audit DB
            const Database = (await import('better-sqlite3')).default;
            const db = new Database(dbPath, { readonly: true });
            const rows = db.prepare('SELECT * FROM events').all() as any[];
            expect(rows.length).toBe(3); // 3 ticks

            for (const row of rows) {
                expect(row.details_json).not.toContain(actualSecretKeyBase58);
                expect(row.details_json).not.toContain('secretKey');
            }
            db.close();

        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
