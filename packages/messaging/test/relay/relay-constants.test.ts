import { describe, expect, it } from 'vitest';

import {
  AMQP_CLOSE_TIMEOUT_MS,
  AMQP_HEARTBEAT_SECONDS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  CLAIM_LEASE_MS,
  MAX_ATTEMPTS,
  PUBLISH_CONFIRM_TIMEOUT_MS,
  RELAY_STOP_WAIT_MS,
  UNROUTED_QUEUE_MAX_LENGTH,
  UNROUTED_QUEUE_MESSAGE_TTL_MS,
} from '@/relay/relay-constants';

/** The `SHUTDOWN_TIMEOUT_MS` default in `packages/config`, which `messaging` does not import. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const MILLISECONDS_PER_SECOND = 1000;
/**
 * amqplib checks for incoming activity once per interval and gives up after two empty checks, so a
 * silent link is noticed between two and three intervals after it goes quiet: three in the worst case.
 */
const WORST_CASE_HEARTBEAT_INTERVALS_BEFORE_CLOSE = 3;
/** Closing waits this many times: once for the channel and once for the connection. */
const CLOSE_STEPS = 2;

describe('relay constants', () => {
  it('keeps the lease above the confirm timeout, so a normal batch never loses its lease', () => {
    expect(CLAIM_LEASE_MS).toBeGreaterThan(PUBLISH_CONFIRM_TIMEOUT_MS);
  });

  it('keeps the stop wait below the default shutdown timeout', () => {
    expect(RELAY_STOP_WAIT_MS).toBeLessThan(DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });

  it('keeps the worst case of a silent link, three heartbeat intervals, inside the confirm timeout, so a dead link closes before a publish times out', () => {
    const deadLinkDetectionMs =
      WORST_CASE_HEARTBEAT_INTERVALS_BEFORE_CLOSE *
      AMQP_HEARTBEAT_SECONDS *
      MILLISECONDS_PER_SECOND;

    expect(deadLinkDetectionMs).toBeLessThan(PUBLISH_CONFIRM_TIMEOUT_MS);
  });

  it('leaves room to stop the relay and close the channel and the connection inside the default shutdown timeout', () => {
    const shutdownWorkMs = RELAY_STOP_WAIT_MS + CLOSE_STEPS * AMQP_CLOSE_TIMEOUT_MS;

    expect(shutdownWorkMs).toBeLessThan(DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });

  it('uses the ADR-0005 values for the catch-all queue', () => {
    expect({
      messageTtlMs: UNROUTED_QUEUE_MESSAGE_TTL_MS,
      maxLength: UNROUTED_QUEUE_MAX_LENGTH,
    }).toEqual({ messageTtlMs: 7 * 24 * 60 * 60 * 1000, maxLength: 100_000 });
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
