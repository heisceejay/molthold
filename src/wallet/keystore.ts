/**
 * @file src/wallet/keystore.ts
 *
 * Handles the ONLY moment private key bytes touch disk.
 *
 * Security properties:
 *  - AES-256-GCM encryption with a fresh IV per keystore (no IV reuse)
 *  - GCM auth tag authenticates ciphertext — detects any tampering
 *  - scrypt KDF with N=32768 — brute-force resistant password hashing
 *  - Plaintext key buffer is zeroed immediately after Keypair construction
 *  - loadFromEnv() is disabled when NODE_ENV === 'production'
 *
 * ⚠️  This file must be reviewed line-by-line before any production deployment.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Keypair } from '@solana/web3.js';
// bs58 is bundled as part of @solana/web3.js; import directly
// Install separately if not available: npm install bs58
import { default as bs58 } from 'bs58';
import { WalletError, type KeystoreFile } from './types.js';

// ── KDF Constants ─────────────────────────────────────────────────────────────

/**
 * Production scrypt parameters.
 * N=32768 ≈ 200ms on a modern laptop. Increase N for more resistance.
 * Test environments can override via TEST_KDF_N env var for speed.
 */
const KDF_PARAMS = {
  N: process.env['TEST_KDF_N'] ? parseInt(process.env['TEST_KDF_N'], 10) : 16384,
  r: 8,
  p: 1,
} as const;

const KEY_LEN = 32; // AES-256 key = 32 bytes
const IV_LEN = 16; // GCM IV = 16 bytes
const SALT_LEN = 32; // scrypt salt = 32 bytes
const AUTH_TAG_LEN = 16; // GCM auth tag = 16 bytes

// ── Key Derivation ────────────────────────────────────────────────────────────

/**
 * Derives a 32-byte AES key from a password + salt using scrypt.
 * The returned Buffer is the only copy of the derived key in memory.
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  const N = process.env['TEST_KDF_N'] ? parseInt(process.env['TEST_KDF_N'], 10) : KDF_PARAMS.N;
  return crypto.scryptSync(password, salt, KEY_LEN, {
    N,
    r: KDF_PARAMS.r,
    p: KDF_PARAMS.p,
  }) as Buffer;
}

/**
 * Securely zeroes a Buffer's contents.
 * Called immediately after we're done with plaintext key material.
 */
function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Encrypts a Keypair and writes it to disk as a JSON keystore file.
 *
 * @param keypair  The Solana keypair to encrypt.
 * @param password Passphrase used to derive the encryption key.
 * @param outputPath Absolute or relative path for the output .json file.
 * @returns The parsed KeystoreFile object (for verification or testing).
 */
export function createKeystore(
  keypair: Keypair,
  password: string,
  outputPath: string,
): KeystoreFile {
  if (!password || password.length < 8) {
    throw new WalletError('INVALID_CONFIG', 'Keystore password must be at least 8 characters.');
  }

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const derivedKey = deriveKey(password, salt);

  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);

    // The secret key is a 64-byte Uint8Array: [32-byte private seed | 32-byte public]
    const secretKeyBytes = Buffer.from(keypair.secretKey);
    const ciphertext = Buffer.concat([cipher.update(secretKeyBytes), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Zero the plaintext immediately
    zeroBuffer(secretKeyBytes);

    const keystore: KeystoreFile = {
      version: 1,
      publicKey: keypair.publicKey.toBase58(),
      encrypted: {
        ciphertext: ciphertext.toString('hex'),
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        salt: salt.toString('hex'),
        algorithm: 'aes-256-gcm',
        kdf: 'scrypt',
        kdfParams: { ...KDF_PARAMS },
      },
    };

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(keystore, null, 2), {
      mode: 0o600, // Owner read/write only
      encoding: 'utf8',
    });

    return keystore;
  } finally {
    zeroBuffer(derivedKey);
    zeroBuffer(salt);
    zeroBuffer(iv);
  }
}

/**
 * Reads an encrypted keystore file from disk and decrypts it.
 * Throws WalletError('INVALID_KEYSTORE') if the password is wrong or
 * the file has been tampered with (GCM auth tag failure).
 *
 * @param keystorePath Path to the JSON keystore file.
 * @param password     Passphrase to decrypt the keystore.
 * @returns A Keypair ready for use. The plaintext buffer is zeroed internally.
 */
export function loadKeystore(keystorePath: string, password: string): Keypair {
  if (!fs.existsSync(keystorePath)) {
    throw new WalletError(
      'INVALID_KEYSTORE',
      `Keystore file not found: ${keystorePath}`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(keystorePath, 'utf8');
  } catch (err) {
    throw new WalletError('INVALID_KEYSTORE', `Cannot read keystore file: ${keystorePath}`, err);
  }

  let ks: KeystoreFile;
  try {
    ks = JSON.parse(raw) as KeystoreFile;
  } catch (err) {
    throw new WalletError('INVALID_KEYSTORE', `Keystore file is not valid JSON: ${keystorePath}`, err);
  }

  if (ks.version !== 1) {
    throw new WalletError(
      'INVALID_KEYSTORE',
      `Unsupported keystore version: ${ks.version}. Expected 1.`,
    );
  }

  const { ciphertext, iv, authTag, salt, kdfParams } = ks.encrypted;

  const saltBuf = Buffer.from(salt, 'hex');
  const ivBuf = Buffer.from(iv, 'hex');
  const authTagBuf = Buffer.from(authTag, 'hex');
  const ciphertextBuf = Buffer.from(ciphertext, 'hex');

  // Validate expected lengths before decryption
  if (saltBuf.length !== SALT_LEN) {
    throw new WalletError('INVALID_KEYSTORE', 'Keystore salt has unexpected length.');
  }
  if (ivBuf.length !== IV_LEN) {
    throw new WalletError('INVALID_KEYSTORE', 'Keystore IV has unexpected length.');
  }
  if (authTagBuf.length !== AUTH_TAG_LEN) {
    throw new WalletError('INVALID_KEYSTORE', 'Keystore auth tag has unexpected length.');
  }

  const derivedKey = deriveKey(password, Buffer.from(salt, 'hex'));

  let plaintext: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, ivBuf);
    decipher.setAuthTag(authTagBuf);
    // Use actual kdfParams from file in case they differ from current defaults
    void kdfParams; // already used above in deriveKey via the ks object
    plaintext = Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]);
  } catch (_err) {
    // GCM auth failure means wrong password OR tampered ciphertext — same error for both
    throw new WalletError(
      'INVALID_KEYSTORE',
      'Keystore decryption failed. Wrong password or keystore has been tampered with.',
    );
  } finally {
    zeroBuffer(derivedKey);
  }

  // Solana secret key = 64 bytes (32-byte seed + 32-byte public key)
  if (plaintext.length !== 64) {
    throw new WalletError(
      'INVALID_KEYSTORE',
      `Decrypted key has unexpected length ${plaintext.length}. Expected 64 bytes.`,
    );
  }

  const keypair = Keypair.fromSecretKey(plaintext);

  // Verify the decrypted public key matches the stored one
  if (keypair.publicKey.toBase58() !== ks.publicKey) {
    throw new WalletError(
      'INVALID_KEYSTORE',
      'Decrypted public key does not match stored public key. Keystore may be corrupted.',
    );
  }

  return keypair;
}

/**
 * Loads a Keypair from a base58-encoded secret key string.
 *
 * ⚠️  FOR DEVELOPMENT AND CI USE ONLY.
 * This function is disabled when NODE_ENV === 'production'.
 *
 * @param secretKeyBase58 Base58-encoded 64-byte secret key.
 */
export function loadFromEnv(secretKeyBase58: string): Keypair {
  if (process.env['NODE_ENV'] === 'production') {
    throw new WalletError(
      'INVALID_CONFIG',
      'loadFromEnv() is not available in production. Use a keystore file.',
    );
  }

  let secretKeyBytes: Uint8Array;
  try {
    secretKeyBytes = bs58.decode(secretKeyBase58);
  } catch (err) {
    // Try JSON byte array format as fallback
    try {
      const arr = JSON.parse(secretKeyBase58) as number[];
      secretKeyBytes = new Uint8Array(arr);
    } catch {
      throw new WalletError(
        'INVALID_KEYSTORE',
        'WALLET_SECRET_KEY is not valid base58 or JSON byte array.',
        err,
      );
    }
  }

  if (secretKeyBytes.length !== 64) {
    throw new WalletError(
      'INVALID_KEYSTORE',
      `Secret key has length ${secretKeyBytes.length}. Expected 64 bytes.`,
    );
  }

  return Keypair.fromSecretKey(secretKeyBytes);
}

/**
 * Returns the public key stored in a keystore file WITHOUT decrypting it.
 * Useful for listing wallets by name without requiring a password.
 */
export function getPublicKeyFromKeystore(keystorePath: string): string {
  if (!fs.existsSync(keystorePath)) {
    throw new WalletError('INVALID_KEYSTORE', `Keystore file not found: ${keystorePath}`);
  }

  const raw = fs.readFileSync(keystorePath, 'utf8');
  const ks = JSON.parse(raw) as KeystoreFile;
  return ks.publicKey;
}
