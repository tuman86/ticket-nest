import { Router } from 'express';
import { type Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createRateLimitMiddleware } from '@/rate-limit/rate-limit.middleware';
import { RateLimitService } from '@/rate-limit/rate-limit.service';
import { type RateLimitPolicy } from '@/rate-limit/rate-limit-policies';
import { RedisFixedWindowRateLimiter } from '@/rate-limit/redis-fixed-window-rate-limiter';

import { createTestApp, type TestApp } from '../../support/create-test-app';
import { createTestRedis } from '../../support/test-redis';

const PATH = '/v1/auth/login';
const PEPPER = 'a-test-pepper-that-is-long-enough-1';
const EMAIL = 'ada@example.com';
const REFRESH_PATH = '/v1/auth/refresh';
const REFRESH_TOKEN = 'refresh-token-value-0123456789';
const TOKEN_LIMIT = 2;
const IP_LIMIT = 4;
const EMAIL_LIMIT = 2;
const WINDOW_MS = 1_000;
const WINDOW_END_MARGIN_MS = 200;

/** The login policy's shape with a window short enough to wait out in a test. */
const POLICY: RateLimitPolicy = {
  name: 'login',
  failureMode: 'fail-closed',
  rules: [
    { scope: 'ip', limit: IP_LIMIT, windowMs: WINDOW_MS },
    { scope: 'email', limit: EMAIL_LIMIT, windowMs: WINDOW_MS },
  ],
};

/** The refresh policy's shape with a short window and a small token limit. */
const REFRESH_TEST_POLICY: RateLimitPolicy = {
  name: 'refresh',
  failureMode: 'fail-open',
  rules: [
    { scope: 'ip', limit: IP_LIMIT, windowMs: WINDOW_MS },
    { scope: 'refresh-token', limit: TOKEN_LIMIT, windowMs: WINDOW_MS },
  ],
};

let redis: Redis;
let testApp: TestApp;

/**
 * Pauses a test until a fixed window has passed.
 *
 * @param milliseconds - How long to wait.
 * @returns A promise that settles after that long.
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Sends one login-shaped request.
 *
 * @param email - Email in the body, or undefined to send none.
 * @param forwardedFor - Client IP to claim, honoured because the test app trusts one proxy hop.
 * @returns The Supertest response.
 */
function postLogin(email: string | undefined, forwardedFor: string): request.Test {
  return request(testApp.app)
    .post(PATH)
    .set('X-Forwarded-For', forwardedFor)
    .send(email === undefined ? {} : { email, password: 'irrelevant-password' });
}

beforeAll(async () => {
  redis = await createTestRedis(inject('redisUrl'));
  testApp = createTestApp(
    { trustProxyHops: 1 },
    {
      buildRouters: (logger) => {
        const router = Router();
        const rateLimitService = new RateLimitService({
          rateLimiter: new RedisFixedWindowRateLimiter(redis),
          keyPepper: PEPPER,
          logger,
        });
        router.post(
          PATH,
          createRateLimitMiddleware({ rateLimitService, policy: POLICY }),
          (_request, response) => {
            response.status(204).end();
          },
        );
        router.post(
          REFRESH_PATH,
          createRateLimitMiddleware({ rateLimitService, policy: REFRESH_TEST_POLICY }),
          (_request, response) => {
            response.status(204).end();
          },
        );
        return [router];
      },
    },
  );
});

beforeEach(async () => {
  await redis.flushall();
});

afterAll(async () => {
  await redis.quit();
});

describe('rate limiting over HTTP with real Redis', () => {
  it('lets requests under the limit through', async () => {
    const response = await postLogin(EMAIL, '198.51.100.1');

    expect(response.status).toBe(204);
  });

  it('lets the request at the limit through and answers 429 with Retry-After on the next', async () => {
    for (let index = 0; index < EMAIL_LIMIT; index += 1) {
      expect((await postLogin(EMAIL, '198.51.100.1')).status).toBe(204);
    }

    const response = await postLogin(EMAIL, '198.51.100.1');

    expect(response.status).toBe(429);
    expect(response.type).toBe('application/problem+json');
    expect(response.body).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    // The window is 1 second, so the time left rounds up to exactly 1.
    expect(response.headers['retry-after']).toBe('1');
    expect(response.headers['ratelimit-limit']).toBe(String(EMAIL_LIMIT));
    expect(response.headers['ratelimit-remaining']).toBe('0');
  });

  it('lets requests through again once the window has passed', async () => {
    for (let index = 0; index <= EMAIL_LIMIT; index += 1) {
      await postLogin(EMAIL, '198.51.100.1');
    }
    expect((await postLogin(EMAIL, '198.51.100.1')).status).toBe(429);

    await sleep(WINDOW_MS + WINDOW_END_MARGIN_MS);

    expect((await postLogin(EMAIL, '198.51.100.1')).status).toBe(204);
  });

  it('applies the IP key: many emails from one IP are stopped at the IP limit', async () => {
    for (let index = 0; index < IP_LIMIT; index += 1) {
      expect((await postLogin(`user-${String(index)}@example.com`, '198.51.100.2')).status).toBe(
        204,
      );
    }

    const response = await postLogin('fresh@example.com', '198.51.100.2');

    expect(response.status).toBe(429);
    expect(response.headers['ratelimit-limit']).toBe(String(IP_LIMIT));
  });

  it('applies the email key: one email from many IPs is stopped at the email limit', async () => {
    for (let index = 0; index < EMAIL_LIMIT; index += 1) {
      expect((await postLogin(EMAIL, `198.51.100.${String(10 + index)}`)).status).toBe(204);
    }

    const response = await postLogin(EMAIL, '198.51.100.99');

    expect(response.status).toBe(429);
    expect(response.headers['ratelimit-limit']).toBe(String(EMAIL_LIMIT));
  });

  it('treats the same email in another case or with spaces as the same account', async () => {
    await postLogin('ADA@example.com', '198.51.100.20');
    await postLogin('  ada@EXAMPLE.com ', '198.51.100.21');

    const response = await postLogin(EMAIL, '198.51.100.22');

    expect(response.status).toBe(429);
  });

  it('does not let a blocked IP use up an email counter', async () => {
    for (let index = 0; index < IP_LIMIT; index += 1) {
      await postLogin(`user-${String(index)}@example.com`, '198.51.100.30');
    }
    for (let index = 0; index < EMAIL_LIMIT + 1; index += 1) {
      await postLogin(EMAIL, '198.51.100.30');
    }

    const fromAnotherIp = await postLogin(EMAIL, '198.51.100.31');

    expect(fromAnotherIp.status).toBe(204);
  });

  it('counts a request with no usable email against the IP only', async () => {
    for (let index = 0; index < IP_LIMIT; index += 1) {
      expect((await postLogin(undefined, '198.51.100.40')).status).toBe(204);
    }

    expect((await postLogin(undefined, '198.51.100.40')).status).toBe(429);
  });

  it('stores no plaintext email and no IP-less identifiers in Redis', async () => {
    await postLogin(EMAIL, '198.51.100.50');

    const keys = await redis.keys('*');

    expect(keys).toHaveLength(2);
    expect(keys.join('\n')).not.toContain(EMAIL);
    expect(keys.join('\n')).not.toContain(PEPPER);
    expect(keys.every((key) => key.startsWith('rl:v1:login:'))).toBe(true);
  });

  it('limits a refresh token on its own key and never stores the token', async () => {
    for (let index = 0; index < TOKEN_LIMIT; index += 1) {
      const response = await request(testApp.app)
        .post(REFRESH_PATH)
        .set('X-Forwarded-For', `198.51.100.${String(60 + index)}`)
        .send({ refreshToken: REFRESH_TOKEN });
      expect(response.status).toBe(204);
    }

    const response = await request(testApp.app)
      .post(REFRESH_PATH)
      .set('X-Forwarded-For', '198.51.100.99')
      .send({ refreshToken: REFRESH_TOKEN });

    expect(response.status).toBe(429);
    expect(response.headers['ratelimit-limit']).toBe(String(TOKEN_LIMIT));
    const keys = (await redis.keys('*')).join('\n');
    expect(keys).not.toContain(REFRESH_TOKEN);
    expect(keys).not.toContain(PEPPER);
    expect(keys).toMatch(/rl:v1:refresh:refresh-token:[0-9a-f]{64}/);
  });

  it('stores a forwarded value that is not an IP address as the shared unknown bucket', async () => {
    const response = await postLogin(undefined, 'not-an-ip-<script>');

    expect(response.status).toBe(204);
    const keys = await redis.keys('*');
    expect(keys).toEqual(['rl:v1:login:ip:unknown']);
  });
});
