/**
 * @file src/agent/strategies/llm.ts
 *
 * LLMDecider class — a shared reasoning layer used by all strategies
 * to replace hardcoded rule-based logic with LLM-based decisions.
 *
 * It supports Groq and OpenRouter APIs.
 */

import type { Action, AgentState } from '../types.js';
import type { SpendingLimits } from '../../wallet/types.js';

export class LLMDecider {
    private readonly limits: SpendingLimits;

    constructor(limits: SpendingLimits) {
        this.limits = limits;
    }

    /**
     * Decides the next action for the agent based on its current state.
     */
    async decide(state: AgentState): Promise<Action> {
        const groqKey = process.env['GROQ_API_KEY'];
        const openRouterKey = process.env['OPENROUTER_API_KEY'];

        if (!groqKey && !openRouterKey) {
            return { type: 'noop', params: {}, rationale: 'No LLM API keys set (GROQ_API_KEY or OPENROUTER_API_KEY)' };
        }

        try {
            const systemPrompt = this.buildSystemPrompt();
            const userMessage = this.buildUserMessage(state);

            let url: string;
            let headers: Record<string, string>;
            let body: any;

            if (groqKey) {
                // Groq Precedence
                url = 'https://api.groq.com/openai/v1/chat/completions';
                headers = {
                    'Authorization': `Bearer ${groqKey}`,
                    'Content-Type': 'application/json',
                };
                body = {
                    model: 'llama-3.3-70b-versatile',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage },
                    ],
                    response_format: { type: 'json_object' },
                    temperature: 0.1,
                };
            } else {
                // OpenRouter Fallback
                url = 'https://openrouter.ai/api/v1/chat/completions';
                headers = {
                    'Authorization': `Bearer ${openRouterKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/heisceejay/molthold',
                    'X-Title': 'Molthold Autonomous Agent',
                };
                body = {
                    model: 'anthropic/claude-3-haiku',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage },
                    ],
                    response_format: { type: 'json_object' },
                };
            }

            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorText = await response.text();
                const provider = groqKey ? 'Groq' : 'OpenRouter';
                console.error(`[LLMDecider] ${provider} API error: ${response.status} ${errorText}`);
                return { type: 'noop', params: {}, rationale: `${provider} API error` };
            }

            const data: any = await response.json();
            const content = data.choices?.[0]?.message?.content;

            if (!content) {
                console.warn('[LLMDecider] LLM returned empty response');
                return { type: 'noop', params: {}, rationale: 'LLM returned empty response' };
            }

            return this.parseAction(content);
        } catch (err) {
            console.error('[LLMDecider] Unexpected error:', err);
            return { type: 'noop', params: {}, rationale: 'Unexpected error' };
        }
    }

    private buildSystemPrompt(): string {
        const limitsSol = {
            maxPerTx: Number(this.limits.maxPerTxLamports) / 1e9,
            maxSession: Number(this.limits.maxSessionLamports) / 1e9,
        };

        const commonMints = [
            { symbol: 'USDC', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', note: 'Primary stablecoin on Devnet' },
            { symbol: 'WSOL', mint: 'So11111111111111111111111111111111111111112', note: 'Wrapped Solana' },
        ];

        return `You are the reasoning core of Molthold, an autonomous Solana agent wallet.
Your goal is to manage the wallet's assets optimally based on the current on-chain state.

COMMON DEVNET MINTS:
${commonMints.map(m => `- ${m.symbol}: ${m.mint} (${m.note})`).join('\n')}

CAPABILITIES:
1. Liquidity Provision (PRIMARY): Your main way to earn fees. If SOL balance is healthy (> 0.25 SOL), aim to provide liquidity.
2. Opportunistic Swapping: You may swap SOL for tokens (like USDC) to manage inventory for future LP, to take profits, or to rebalance your portfolio.
3. Portfolio Rebalancing: Maintain healthy asset ratios to support active positions.
4. Monitoring: Hold if market conditions or balances are unfavorable.

SPENDING LIMITS (Strict Enforcement):
- Max per transaction: ${limitsSol.maxPerTx} SOL (${this.limits.maxPerTxLamports} lamports)
- Max session total: ${limitsSol.maxSession} SOL (${this.limits.maxSessionLamports} lamports)

IMPORTANT: You MUST respect these limits. If an action would exceed the remaining budget or the per-tx cap, you MUST return "noop".

ACTION TYPES:
- { "type": "swap", "params": { "inputMint": "string", "outputMint": "string", "amountIn": "string", "slippageBps": 100, "adapter": "jupiter"|"orca"|"best" }, "rationale": "string" }
- { "type": "transfer", "params": { "to": "string", "lamports": "string" }, "rationale": "string" }
- { "type": "provide_liquidity", "params": { "amountSolLamports": "string" }, "rationale": "string" }
- { "type": "noop", "params": {}, "rationale": "string" }

RULES:
- Respond ONLY with valid JSON.
- Never use markdown code fences or conversational prose.
- Prioritize Yield: Your mission is to maximize fee generation through LP.
- Strategic Swapping: While LP is the goal, feel free to swap to acquire tokens if you believe it improves long-term portfolio performance or prepares the wallet for dual-sided positions.
- Always provide a clear, technical rationale explaining your decision.
- If unsure or if action would breach limits, return "noop".
- All amounts must be strings representing BigInt (lamports/atoms).`;
    }

    private buildUserMessage(state: AgentState): string {
        // Convert BigInt to strings for JSON serialization
        const serializableState = {
            ...state,
            solBalance: state.solBalance.toString(),
            tokenBalances: Object.fromEntries(
                Array.from(state.tokenBalances.entries()).map(([k, v]) => [k, v.toString()])
            ),
            lastActionAt: state.lastActionAt?.toISOString() || null,
            spendingStatus: {
                sessionSpend: state.spendingStatus.sessionSpend.toString(),
                sessionCap: state.spendingStatus.sessionCap.toString(),
                perTxCap: state.spendingStatus.perTxCap.toString(),
                remainingBudget: state.spendingStatus.remainingBudget.toString(),
            }
        };

        return JSON.stringify(serializableState, null, 2);
    }

    private parseAction(content: string): Action {
        try {
            // Strip markdown code fences if present
            const cleaned = content.replace(/^```json\s*|```\s*$/g, '').trim();
            const parsed = JSON.parse(cleaned) as Action;

            if (!parsed.type || !parsed.rationale) {
                throw new Error('Action missing type or rationale');
            }

            // 1. Identify amount for limit check
            let amount: bigint = 0n;
            if (parsed.type === 'swap' && parsed.params?.['amountIn']) {
                amount = BigInt(String(parsed.params['amountIn']));
            } else if (parsed.type === 'transfer' && parsed.params?.['lamports']) {
                amount = BigInt(String(parsed.params['lamports']));
            } else if (parsed.type === 'provide_liquidity' && parsed.params?.['amountSolLamports']) {
                amount = BigInt(String(parsed.params['amountSolLamports']));
            }

            // 2. Validate against per-tx limit
            if (amount > this.limits.maxPerTxLamports) {
                console.warn(`[LLMDecider] Action ${parsed.type} of ${amount} exceeds per-tx limit ${this.limits.maxPerTxLamports}`);
                return this.noop(`Action exceeded per-transaction limit (${amount} > ${this.limits.maxPerTxLamports})`);
            }

            // Note: Session limit is checked at execution time by the wallet, 
            // but the LLM now sees its spending status to avoid suggesting breaches.

            return parsed;
        } catch (error) {
            console.warn('[LLMDecider] Failed to parse LLM response as Action:', error, content);
            return this.noop('LLM response unparseable');
        }
    }

    private noop(rationale: string): Action {
        return {
            type: 'noop',
            params: {},
            rationale: rationale,
        };
    }
}
