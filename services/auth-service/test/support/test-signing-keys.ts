import { generateKeyPairSync, type KeyObject } from 'node:crypto';

export const TEST_KEY_ID = 'test-key-1';
export const TEST_ISSUER = 'https://auth.test.ticketnest.example';
export const TEST_AUDIENCE = 'ticketnest-test-api';

export interface TestSigningKeys {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/**
 * Generates a throwaway Ed25519 key pair, so no signing key is ever committed to the repository.
 *
 * @returns A fresh key pair for one test file.
 */
export function generateTestSigningKeys(): TestSigningKeys {
  return generateKeyPairSync('ed25519');
}
