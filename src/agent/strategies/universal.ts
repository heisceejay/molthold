/**
 * @file src/agent/strategies/universal.ts
 *
 * Universal Strategy — handles execution for all LLM-decided actions.
 */

import { Connection, Transaction, SystemProgram } from '@solana/web3.js';
import type { Strategy, AgentState, Action, SwapActionParams, TransferActionParams, ProvideLiquidityActionParams } from '../types.js';
import type { WalletClient, TxResult } from '../../wallet/types.js';
import type { AdapterRegistry } from '../../protocols/types.js';
import { safePublicKey } from '../../utils.js';
import { LLMDecider } from './llm.js';

export class UniversalStrategy implements Strategy {
    readonly name = 'universal';
    private readonly llmDecider: LLMDecider;
    private readonly rpcUrl: string;

    constructor(llmDecider: LLMDecider, rpcUrl: string) {
        this.llmDecider = llmDecider;
        this.rpcUrl = rpcUrl;
    }

    async decide(state: AgentState): Promise<Action> {
        return this.llmDecider.decide(state);
    }

    async execute(
        action: Action,
        wallet: WalletClient,
        adapters: AdapterRegistry,
    ): Promise<TxResult | null> {
        if (action.type === 'noop') return null;

        try {
            switch (action.type) {
                case 'swap':
                    return await this.executeSwap(action.params as any, wallet, adapters);
                case 'transfer':
                    return await this.executeTransfer(action.params as any, wallet);
                case 'provide_liquidity':
                    return await this.executeProvideLiquidity(action.params as any, wallet);
                default:
                    throw new Error(`UniversalStrategy: unknown action type '${action.type}'`);
            }
        } catch (err) {
            return {
                signature: null,
                status: 'failed',
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    private async executeSwap(
        params: SwapActionParams,
        wallet: WalletClient,
        adapters: AdapterRegistry,
    ): Promise<TxResult> {
        const { inputMint, outputMint, amountIn, slippageBps, adapter } = params;
        const inputPk = safePublicKey(inputMint);
        const outputPk = safePublicKey(outputMint);
        const amount = typeof amountIn === 'bigint' ? amountIn : BigInt(String(amountIn));

        let quote;
        let adapterName: 'jupiter' | 'orca';

        if (adapter === 'jupiter' || adapter === 'orca') {
            adapterName = adapter;
            quote = await adapters.get(adapter).quote(inputPk, outputPk, amount);
        } else {
            // Default to best
            const best = await adapters.getBestQuote(inputPk, outputPk, amount);
            quote = best.quote;
            adapterName = best.adapter;
        }

        return await adapters.get(adapterName).swap(wallet, quote, slippageBps);
    }

    private async executeTransfer(
        params: TransferActionParams,
        wallet: WalletClient,
    ): Promise<TxResult> {
        const { to, lamports } = params;
        const toPk = safePublicKey(to);
        const amount = typeof lamports === 'bigint' ? lamports : BigInt(String(lamports));

        const connection = new Connection(this.rpcUrl, 'confirmed');
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: toPk,
                lamports: Number(amount),
            })
        );

        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = wallet.publicKey;

        return await wallet.signAndSendTransaction(tx, amount);
    }

    private async executeProvideLiquidity(
        params: ProvideLiquidityActionParams,
        wallet: WalletClient,
    ): Promise<TxResult> {
        // Simple transfer simulation for now, as in the original MarketMakerStrategy
        const { amountSolLamports } = params;
        const amount = typeof amountSolLamports === 'bigint' ? amountSolLamports : BigInt(String(amountSolLamports));

        const connection = new Connection(this.rpcUrl, 'confirmed');
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: wallet.publicKey, // Self-transfer simulation
                lamports: Number(amount),
            })
        );

        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = wallet.publicKey;

        // Self-transfer for LP simulation doesn't "spend" SOL from the session budget
        return await wallet.signAndSendTransaction(tx, 0n);
    }
}
