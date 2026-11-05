import { describe, expect, it } from 'vitest';

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  CLAIM_LEASE_MS,
  MAX_ATTEMPTS,
  PUBLISH_CONFIRM_TIMEOUT_MS,
  RELAY_STOP_WAIT_MS,
} from '@/relay/relay-constants';

/** The `SHUTDOWN_TIMEOUT_MS` default in `packages/config`, which `messaging` does not import. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

describe('relay constants', () => {
  it('keeps the lease above the confirm timeout, so a normal batch never loses its lease', () => {
    expect(CLAIM_LEASE_MS).toBeGreaterThan(PUBLISH_CONFIRM_TIMEOUT_MS);
  });

  it('keeps the stop wait below the default shutdown timeout', () => {
    expect(RELAY_STOP_WAIT_MS).toBeLessThan(DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });

  it('uses the ADR-0007 starting values', () => {
    expect({
      confirmTimeoutMs: PUBLISH_CONFIRM_TIMEOUT_MS,
      leaseMs: CLAIM_LEASE_MS,
      stopWaitMs: RELAY_STOP_WAIT_MS,
      maxAttempts: MAX_ATTEMPTS,
      backoffBaseMs: BACKOFF_BASE_MS,
      backoffCapMs: BACKOFF_CAP_MS,
    }).toEqual({
      confirmTimeoutMs: 10_000,
      leaseMs: 60_000,
      stopWaitMs: 5_000,
      maxAttempts: 10,
      backoffBaseMs: 1_000,
      backoffCapMs: 300_000,
    });
  });
});
