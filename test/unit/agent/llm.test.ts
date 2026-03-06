import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMDecider } from '../../../src/agent/strategies/llm.js';
import type { AgentState } from '../../../src/agent/types.js';

describe('LLMDecider', () => {
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
        tokenBalances: new Map([['TokenMint1111111111111111111111111', 1000n]]),
        lastActionAt: new Date(),
        tickCount: 1,
        snapshotAt: Date.now(),
        spendingStatus: {
            sessionSpend: 0n,
            sessionCap: 1_000_000_000n,
            perTxCap: 100_000_000n,
            remainingBudget: 1_000_000_000n,
        },
    };

    beforeEach(() => {
        delete process.env['GROQ_API_KEY'];
        delete process.env['OPENROUTER_API_KEY'];
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns error if no API keys are set', async () => {
        const decider = new LLMDecider(mockLimits, mockLogger);
        const result = await decider.decide(mockState);
        expect(result.type).toBe('noop');
        expect(result.rationale).toContain('No LLM API keys set');
    });

    it('uses Groq when GROQ_API_KEY is set', async () => {
        process.env['GROQ_API_KEY'] = 'groq-key';
        const mockAction = { type: 'noop', rationale: 'Using Groq' };

        (fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify(mockAction) } }],
            }),
        });

        const decider = new LLMDecider(mockLimits, mockLogger);
        await decider.decide(mockState);

        const [url, opts] = (fetch as any).mock.calls[0];
        expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
        expect(opts.headers['Authorization']).toBe('Bearer groq-key');
        const body = JSON.parse(opts.body);
        expect(body.model).toBe('llama-3.3-70b-versatile');
    });

    it('uses OpenRouter when only OPENROUTER_API_KEY is set', async () => {
        process.env['OPENROUTER_API_KEY'] = 'or-key';
        const mockAction = { type: 'noop', rationale: 'Using OR' };

        (fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify(mockAction) } }],
            }),
        });

        const decider = new LLMDecider(mockLimits, mockLogger);
        await decider.decide(mockState);

        const [url, opts] = (fetch as any).mock.calls[0];
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(opts.headers['Authorization']).toBe('Bearer or-key');
        const body = JSON.parse(opts.body);
        expect(body.model).toBe('anthropic/claude-3-haiku');
    });

    it('gives Groq precedence when both keys are set', async () => {
        process.env['GROQ_API_KEY'] = 'groq-key';
        process.env['OPENROUTER_API_KEY'] = 'or-key';

        (fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '{"type":"noop","rationale":"groq wins"}' } }],
            }),
        });

        const decider = new LLMDecider(mockLimits, mockLogger);
        await decider.decide(mockState);

        const [url] = (fetch as any).mock.calls[0];
        expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    });

    it('parses valid JSON action response correctly', async () => {
        process.env['GROQ_API_KEY'] = 'test-key';
        const mockAction = {
            type: 'swap',
            params: { amountIn: '50000000' },
            rationale: 'Reasonable trade',
        };

        (fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify(mockAction) } }],
            }),
        });

        const decider = new LLMDecider(mockLimits, mockLogger);
        const result = await decider.decide(mockState);

        expect(result.type).toBe('swap');
        expect(result.params?.['amountIn']).toBe('50000000');
        expect(result.rationale).toBe('Reasonable trade');
    });

    it('returns noop for unparseable responses', async () => {
        process.env['GROQ_API_KEY'] = 'test-key';
        (fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'Invalid JSON' } }],
            }),
        });

        const decider = new LLMDecider(mockLimits, mockLogger);
        const result = await decider.decide(mockState);

        expect(result.type).toBe('noop');
        expect(result.rationale).toBe('LLM response unparseable');
    });

    it('rejects action exceeding maxPerTxLamports', async () => {
        process.env['GROQ_API_KEY'] = 'test-key';
        const largeAction = {
            type: 'swap',
            params: { amountIn: (mockLimits.maxPerTxLamports + 1n).toString() },
            rationale: 'Greedy trade',
        };

        (fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify(largeAction) } }],
            }),
        });

        const decider = new LLMDecider(mockLimits, mockLogger);
        const result = await decider.decide(mockState);

        expect(result.type).toBe('noop');
        expect(result.rationale).toContain('Action exceeded per-transaction limit');
    });
});
