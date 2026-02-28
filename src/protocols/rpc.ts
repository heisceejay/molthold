/**
 * @file src/protocols/rpc.ts
 * Read-only on-chain helpers. No side effects, no signing, no wallet access.
 * Takes a Connection, returns typed data.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { ProtocolError, type PoolReserves, type TokenPriceResult } from './types.js';
import { safePublicKey } from '../utils.js';

// Orca Whirlpool account layout offsets (v1, 653 bytes)
const WP_TOKEN_MINT_A_OFFSET = 101;
const WP_TOKEN_MINT_B_OFFSET = 133;
const WP_TOKEN_VAULT_A_OFFSET = 165;
const WP_TOKEN_VAULT_B_OFFSET = 197;
const WP_SQRT_PRICE_OFFSET = 229; // u128 LE, 16 bytes

/** Checks whether an on-chain account exists and is initialised. */
export async function accountExists(
  address: PublicKey,
  connection: Connection,
): Promise<boolean> {
  try {
    const info = await connection.getAccountInfo(address, 'confirmed');
    return info !== null && info.lamports > 0;
  } catch (err) {
    throw new ProtocolError('PRICE_FETCH_FAILED', `accountExists failed for ${address.toBase58()}`, err);
  }
}

/**
 * Fetches a token's USD price from Jupiter Price API v6.
 * Returns null priceUsd if Jupiter has no data for the mint.
 */
export async function getTokenPrice(
  mint: PublicKey,
  _connection: Connection,
): Promise<TokenPriceResult> {
  const mintStr = mint.toBase58();
  try {
    const resp = await fetchWithTimeout(
      `https://price.jup.ag/v6/price?ids=${mintStr}`,
      10_000,
    );
    if (!resp.ok) {
      return { mint: mintStr, priceUsd: null, source: 'unknown', fetchedAt: Date.now() };
    }
    const data = await resp.json() as { data: Record<string, { price: number } | undefined> };
    const entry = data.data[mintStr];
    return {
      mint: mintStr,
      priceUsd: entry?.price ?? null,
      source: entry ? 'jupiter' : 'unknown',
      fetchedAt: Date.now(),
    };
  } catch (err) {
    throw new ProtocolError('PRICE_FETCH_FAILED', `getTokenPrice failed for ${mintStr}`, err);
  }
}

/**
 * Fetches reserves for an Orca Whirlpool by parsing its on-chain account data.
 */
export async function getPoolReserves(
  poolAddress: PublicKey,
  connection: Connection,
): Promise<PoolReserves> {
  let info;
  try {
    info = await connection.getAccountInfo(poolAddress, 'confirmed');
  } catch (err) {
    throw new ProtocolError('POOL_NOT_FOUND', `getPoolReserves RPC failed for ${poolAddress.toBase58()}`, err);
  }

  if (!info || info.data.length < 300) {
    throw new ProtocolError('POOL_NOT_FOUND', `Pool ${poolAddress.toBase58()} not found or too small`);
  }

  const d = info.data;
  const mintA = safePublicKey(d.slice(WP_TOKEN_MINT_A_OFFSET, WP_TOKEN_MINT_A_OFFSET + 32));
  const mintB = safePublicKey(d.slice(WP_TOKEN_MINT_B_OFFSET, WP_TOKEN_MINT_B_OFFSET + 32));
  const vaultA = safePublicKey(d.slice(WP_TOKEN_VAULT_A_OFFSET, WP_TOKEN_VAULT_A_OFFSET + 32));
  const vaultB = safePublicKey(d.slice(WP_TOKEN_VAULT_B_OFFSET, WP_TOKEN_VAULT_B_OFFSET + 32));

  const [balA, balB] = await Promise.all([
    connection.getTokenAccountBalance(vaultA, 'confirmed'),
    connection.getTokenAccountBalance(vaultB, 'confirmed'),
  ]);

  // sqrtPrice is a Q64.64 fixed-point u128; price = (sqrtPrice / 2^64)^2
  const sqrtPriceBuf = Buffer.from(d.slice(WP_SQRT_PRICE_OFFSET, WP_SQRT_PRICE_OFFSET + 16));
  const sqrtPrice = readU128LE(sqrtPriceBuf);
  const Q64 = 2n ** 64n;
  const priceAtoB = Number((sqrtPrice * sqrtPrice) / (Q64 * Q64));

  return {
    poolAddress: poolAddress.toBase58(),
    reserveA: BigInt(balA.value.amount),
    reserveB: BigInt(balB.value.amount),
    tokenMintA: mintA.toBase58(),
    tokenMintB: mintB.toBase58(),
    priceAtoB,
    fetchedAt: Date.now(),
  };
}

/**
 * Fetches prices for multiple mints in one API call.
 */
export async function getTokenPrices(
  mints: PublicKey[],
  _connection: Connection,
): Promise<Map<string, TokenPriceResult>> {
  if (mints.length === 0) return new Map();
  const mintStrs = mints.map((m) => m.toBase58());
  const results = new Map<string, TokenPriceResult>();

  try {
    const resp = await fetchWithTimeout(
      `https://price.jup.ag/v6/price?ids=${mintStrs.join(',')}`,
      10_000,
    );
    const data = resp.ok
      ? (await resp.json() as { data: Record<string, { price: number } | undefined> }).data
      : {};

    for (const m of mintStrs) {
      const entry = data[m];
      results.set(m, {
        mint: m,
        priceUsd: entry?.price ?? null,
        source: entry ? 'jupiter' : 'unknown',
        fetchedAt: Date.now(),
      });
    }
  } catch {
    for (const m of mintStrs) {
      if (!results.has(m)) results.set(m, { mint: m, priceUsd: null, source: 'unknown', fetchedAt: Date.now() });
    }
  }

  return results;
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function readU128LE(buf: Buffer): bigint {
  let r = 0n;
  for (let i = 15; i >= 0; i--) r = (r << 8n) | BigInt(buf[i] ?? 0);
  return r;
}
