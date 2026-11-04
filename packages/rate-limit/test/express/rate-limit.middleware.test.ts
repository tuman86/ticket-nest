import { Router, type Request } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { readClientIp } from '@/client-ip';
import { createRateLimitMiddleware } from '@/express/rate-limit.middleware';
import { RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS } from '@/rate-limit-constants';
import { type RateLimitIdentifiers, type RateLimitPolicy } from '@/rate-limit-policy';
import { RateLimitService } from '@/rate-limit.service';

import { createTestApp, type TestApp } from '../support/create-test-app';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

const PATH = '/limited';
const PEPPER = 'a-test-pepper-that-is-long-enough-1';
const EMAIL = 'ada@example.com';
const IP_LIMIT = 3;
const EMAIL_LIMIT = 2;
const WINDOW_MS = 60_000;

const POLICY: RateLimitPolicy = {
  name: 'login',
  failureMode: 'fail-closed',
  rules: [
    { scope: 'ip', limit: IP_LIMIT, windowMs: WINDOW_MS },
    { scope: 'email', limit: EMAIL_LIMIT, windowMs: WINDOW_MS },
  ],
};

/**
 * Reads the IP and, when the body has a string email, the email: the way an endpoint would.
 *
 * @param request - The incoming request.
 * @returns What the policy counts by.
 */
function readIdentifiers(request: Request): RateLimitIdentifiers {
  const body = request.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  return { ip: readClientIp(request.ip), ...(email === '' ? {} : { email }) };
}

let limiter: InMemoryRateLimiter;
let handler: Mock<() => void>;
let testApp: TestApp;

beforeEach(() => {
  limiter = new InMemoryRateLimiter();
  handler = vi.fn<() => void>();
  testApp = createTestApp((logger) => {
    const router = Router();
    const middleware = createRateLimitMiddleware({
      rateLimitService: new RateLimitService({
        rateLimiter: limiter,
        keyPepper: PEPPER,
        logger,
      }),
      policy: POLICY,
      readIdentifiers,
    });
    router.post(PATH, middleware, (_request, response) => {
      handler();
      response.status(204).end();
    });
    return [router];
  });
});

describe('createRateLimitMiddleware', () => {
  it('passes a request under the limit to the handler', async () => {
    const response = await request(testApp.app).post(PATH).send({ email: EMAIL });

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('answers 429 problem+json with the retry headers and never reaches the handler', async () => {
    await request(testApp.app).post(PATH).send({ email: EMAIL });
    await request(testApp.app).post(PATH).send({ email: EMAIL });
    handler.mockClear();

    const response = await request(testApp.app).post(PATH).send({ email: EMAIL });

    expect(response.status).toBe(429);
    expect(response.type).toBe('application/problem+json');
    expect(response.body).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      type: 'https://api.ticketnest.example/problems/rate-limited',
      instance: PATH,
    });
    expect(response.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(response.headers['ratelimit-limit']).toBe(String(EMAIL_LIMIT));
    expect(response.headers['ratelimit-remaining']).toBe('0');
    expect(response.headers['ratelimit-reset']).toBe(response.headers['retry-after']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('applies the IP limit to a body with no usable email, and still lets the handler validate it', async () => {
    for (let index = 0; index < IP_LIMIT; index += 1) {
      const response = await request(testApp.app).post(PATH).send({ email: 42 });
      expect(response.status).toBe(204);
    }

    const response = await request(testApp.app).post(PATH).send({ email: 42 });

    expect(response.status).toBe(429);
    expect(limiter.consumedKeys.every((key) => key.includes(':ip:'))).toBe(true);
  });

  it('answers a failing limiter on a fail-closed policy with 503 and Retry-After', async () => {
    limiter.failure = new Error('connection is closed');

    const response = await request(testApp.app).post(PATH).send({ email: EMAIL });

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe(
      String(RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
    expect(response.body).not.toHaveProperty('detail');
    expect(handler).not.toHaveBeenCalled();
  });

  it('logs a refused request once at error level, with the limiter failure and the policy', async () => {
    limiter.failure = new Error('connection is closed');

    await request(testApp.app).post(PATH).send({ email: EMAIL });

    const errorLines = testApp.lines.filter((line) => line.level === 'error');
    expect(errorLines).toHaveLength(1);
    expect(JSON.stringify(errorLines)).toContain('connection is closed');
    expect(JSON.stringify(testApp.lines)).toContain('"policy":"login"');
    expect(JSON.stringify(testApp.lines)).not.toContain(EMAIL);
  });

  it('never logs the email', async () => {
    for (let index = 0; index <= EMAIL_LIMIT; index += 1) {
      await request(testApp.app).post(PATH).send({ email: EMAIL });
    }

    expect(JSON.stringify(testApp.lines)).not.toContain(EMAIL);
  });
});
