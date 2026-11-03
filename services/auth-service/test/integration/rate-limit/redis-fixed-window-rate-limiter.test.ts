import { type Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { RedisFixedWindowRateLimiter } from '@/rate-limit/redis-fixed-window-rate-limiter';

import { createTestRedis } from '../../support/test-redis';

const KEY = 'rl:v1:test:ip:203.0.113.7';
const LIMIT = 3;
const WINDOW_MS = 60_000;
const SHORT_WINDOW_MS = 1_000;
const WINDOW_END_MARGIN_MS = 150;
const CONCURRENT_REQUESTS = 40;

let redis: Redis;
let limiter: RedisFixedWindowRateLimiter;

/**
 * Pauses a test until a fixed window has passed.
 *
 * @param milliseconds - How long to wait.
 * @returns A promise that settles after that long.
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

beforeAll(async () => {
  redis = await createTestRedis(inject('redisUrl'));
  limiter = new RedisFixedWindowRateLimiter(redis);
});

beforeEach(async () => {
  await redis.flushall();
});

afterAll(async () => {
  await redis.quit();
});

describe('RedisFixedWindowRateLimiter (real Redis)', () => {
  it('allows requests under the limit and counts them down', async () => {
    const first = await limiter.consume(KEY, LIMIT, WINDOW_MS);
    const second = await limiter.consume(KEY, LIMIT, WINDOW_MS);

    expect(first).toMatchObject({ isAllowed: true, limit: LIMIT, remaining: 2 });
    expect(second).toMatchObject({ isAllowed: true, limit: LIMIT, remaining: 1 });
  });

  it('allows the request that reaches the limit and denies the next one', async () => {
    const decisions = [];
    for (let index = 0; index <= LIMIT; index += 1) {
      decisions.push(await limiter.consume(KEY, LIMIT, WINDOW_MS));
    }

    expect(decisions.map((decision) => decision.isAllowed)).toEqual([true, true, true, false]);
    expect(decisions[LIMIT - 1]).toMatchObject({ remaining: 0 });
    expect(decisions[LIMIT]).toMatchObject({ isAllowed: false, remaining: 0 });
  });

  it('reports how long until the window ends, within the window', async () => {
    for (let index = 0; index < LIMIT; index += 1) {
      await limiter.consume(KEY, LIMIT, WINDOW_MS);
    }

    const denied = await limiter.consume(KEY, LIMIT, WINDOW_MS);

    expect(denied.isAllowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(WINDOW_MS);
  });

  it('does not extend the window when a request is denied', async () => {
    for (let index = 0; index < LIMIT; index += 1) {
      await limiter.consume(KEY, LIMIT, SHORT_WINDOW_MS);
    }
    await sleep(WINDOW_END_MARGIN_MS);
    const denied = await limiter.consume(KEY, LIMIT, SHORT_WINDOW_MS);

    expect(denied.retryAfterMs).toBeLessThan(SHORT_WINDOW_MS - WINDOW_END_MARGIN_MS / 2);
  });

  it('allows requests again once the window has passed', async () => {
    for (let index = 0; index <= LIMIT; index += 1) {
      await limiter.consume(KEY, LIMIT, SHORT_WINDOW_MS);
    }
    expect((await limiter.consume(KEY, LIMIT, SHORT_WINDOW_MS)).isAllowed).toBe(false);

    await sleep(SHORT_WINDOW_MS + WINDOW_END_MARGIN_MS);

    const afterReset = await limiter.consume(KEY, LIMIT, SHORT_WINDOW_MS);
    expect(afterReset).toMatchObject({ isAllowed: true, remaining: LIMIT - 1 });
  });

  it('gives every key its own counter', async () => {
    for (let index = 0; index <= LIMIT; index += 1) {
      await limiter.consume(KEY, LIMIT, WINDOW_MS);
    }

    const otherKey = await limiter.consume('rl:v1:test:ip:198.51.100.1', LIMIT, WINDOW_MS);

    expect(otherKey.isAllowed).toBe(true);
  });

  it('never lets more than the limit through under concurrent requests', async () => {
    const decisions = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () => limiter.consume(KEY, LIMIT, WINDOW_MS)),
    );

    expect(decisions.filter((decision) => decision.isAllowed)).toHaveLength(LIMIT);
  });

  it('always sets an expiry, so a counter can never outlive its window', async () => {
    await limiter.consume(KEY, LIMIT, WINDOW_MS);

    const ttlMs = await redis.pttl(KEY);

    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(WINDOW_MS);
  });
});
