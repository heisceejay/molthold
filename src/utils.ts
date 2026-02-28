import { PublicKey } from '@solana/web3.js';

export function safePublicKey(str: string | Uint8Array): PublicKey {
    try {
        return new PublicKey(str);
    } catch (err) {
        throw new Error(`Invalid public key input: ${str}`);
    }
}
