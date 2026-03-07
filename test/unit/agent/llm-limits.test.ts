import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMDecider } from '../../../src/agent/strategies/llm.js';
import type { AgentState } from '../../../src/agent/types.js';

describe('LLMDecider - Session Budget Enforcement', () => {
    const mockLimits = {
        maxPerTxLamports: 100_000_000n, // 0.1 SOL
        maxSessionLamports: 1_000_000_000n, // 1.0 SOL
    };

    const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    } as any;

    const mockState: AgentState = {
        agentId: 'test-agent',
        walletPubkey: 'TestWalletPubkey1111111111111111111111111',
        solBalance: 500_000_000n,
        tokenBalances: new Map(),
        lastActionAt: new Date(),
        tickCount: 1,
        snapshotAt: Date.now(),
        spendingStatus: {
            sessionSpend: 950_000_000n, // Already spent 0.95 SOL
            sessionCap: 1_000_000_000n,
            perTxCap: 100_000_000n,
            remainingBudget: 50_000_000n, // Only 0.05 SOL left
        },
    };

    beforeEach(() => {
        process.env['GROQ_API_KEY'] = 'test-key';
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('rejects action exceeding remainingBudget but under perTxCap', async () => {
        const action = {
            type: 'provide_liquidity',
            params: { amountSolLamports: '60000000' }, // 0.06 SOL > 0.05 SOL remaining
            rationale: 'Adding liquidity',
        };

        (fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify(action) } }],
            }),
        });

        const decider = new LLMDecider(mockLimits, mockLogger);
        const result = await decider.decide(mockState);

        expect(result.type).toBe('noop');
        expect(result.rationale).toContain('Action exceeded remaining session budget');
    });

    it('accepts action under both remainingBudget and perTxCap', async () => {
        const action = {
            type: 'provide_liquidity',
            params: { amountSolLamports: '40000000' }, // 0.04 SOL < 0.05 SOL remaining
            rationale: 'Adding small liquidity',
        };

        (fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify(action) } }],
            }),
        });

        const decider = new LLMDecider(mockLimits, mockLogger);
        const result = await decider.decide(mockState);

        expect(result.type).toBe('provide_liquidity');
        expect(result.params?.['amountSolLamports']).toBe('40000000');
    });
});
