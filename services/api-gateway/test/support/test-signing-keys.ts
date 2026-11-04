import { generateKeyPairSync, type KeyObject } from 'node:crypto';

export const TEST_KEY_ID = 'gateway-test-key';
export const TEST_ISSUER = 'https://auth.test.ticketnest.example';
export const TEST_AUDIENCE = 'ticketnest-test-api';

/** Throwaway Ed25519 keys, generated once per test file, so no signing key is ever committed. */
const keys = generateKeyPairSync('ed25519');

/** @returns The private key tokens are signed with. */
export function getTestPrivateKey(): KeyObject {
  return keys.privateKey;
}

/** @returns The public key the gateway's verifier checks tokens with. */
export function getTestPublicKey(): KeyObject {
  return keys.publicKey;
}
