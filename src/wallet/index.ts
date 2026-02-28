/**
 * @file src/wallet/index.ts
 * Public API for the wallet module. Import from here, not from individual files.
 */

export { createWalletClient } from './wallet.js';
export { createKeystore, loadKeystore, loadFromEnv, getPublicKeyFromKeystore } from './keystore.js';
export { SpendingLimitGuard } from './limits.js';
export type {
  WalletClient,
  WalletConfig,
  WalletError,
  WalletErrorCode,
  TxResult,
  SpendingLimits,
  KeystoreFile,
} from './types.js';
export { WalletError as WalletErr } from './types.js';
