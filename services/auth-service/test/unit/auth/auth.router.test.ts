import {
  RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS,
  type RateLimitPolicy,
} from '@ticketnest/rate-limit';
import { InMemoryRateLimiter } from '@ticketnest/rate-limit/testing';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  LOGIN_POLICY,
  LOGOUT_POLICY,
  REFRESH_POLICY,
  REGISTER_POLICY,
} from '@/rate-limit/rate-limit-policies';

import { createAuthTestApp, type AuthTestApp } from '../../support/create-auth-test-app';

/**
 * Reads how many requests one IP may send per window under a policy.
 *
 * @param policy - A policy whose first rule is the IP rule.
 * @returns How many requests one IP may send in a window.
 */
function readIpLimit(policy: RateLimitPolicy): number {
  return policy.rules[0]?.limit ?? 0;
}

/**
 * Reads how many requests one rule of a policy allows per window.
 *
 * @param policy - A policy with a rule on the given scope.
 * @param scope - Which rule to read.
 * @returns How many requests that rule allows per window.
 */
function readLimit(policy: RateLimitPolicy, scope: string): number {
  return policy.rules.find((rule) => rule.scope === scope)?.limit ?? 0;
}

let limiter: InMemoryRateLimiter;
let testApp: AuthTestApp;

beforeEach(async () => {
  limiter = new InMemoryRateLimiter();
  testApp = await createAuthTestApp({ rateLimiter: limiter });
});

describe('createAuthRouter rate limits', () => {
  // An empty body fails validation with 422, so these requests are cheap but still count.
  it.each([
    ['/v1/auth/register', REGISTER_POLICY],
    ['/v1/auth/login', LOGIN_POLICY],
    ['/v1/auth/refresh', REFRESH_POLICY],
    ['/v1/auth/logout', LOGOUT_POLICY],
  ])('limits %s by IP and answers 429 with Retry-After past the limit', async (path, policy) => {
    for (let index = 0; index < readIpLimit(policy); index += 1) {
      const response = await request(testApp.app).post(path).send({});
      expect(response.status).toBe(422);
    }

    const response = await request(testApp.app).post(path).send({});

    expect(response.status).toBe(429);
    expect(response.type).toBe('application/problem+json');
    expect(response.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(response.headers['ratelimit-limit']).toBe(String(readIpLimit(policy)));
  });

  it('limits login by email too, before the password is checked', async () => {
    const emailLimit = readLimit(LOGIN_POLICY, 'email');
    for (let index = 0; index < emailLimit; index += 1) {
      const response = await request(testApp.app)
        .post('/v1/auth/login')
        .send({ email: 'ada@example.com' });
      expect(response.status).toBe(422);
    }

    const response = await request(testApp.app)
      .post('/v1/auth/login')
      .send({ email: ' ADA@example.com ', password: 'whatever-password' });

    expect(response.status).toBe(429);
    expect(response.headers['ratelimit-limit']).toBe(String(emailLimit));
    expect(testApp.verifySpy).not.toHaveBeenCalled();
  });

  it('limits register by email too', async () => {
    const emailLimit = readLimit(REGISTER_POLICY, 'email');
    for (let index = 0; index < emailLimit; index += 1) {
      const response = await request(testApp.app)
        .post('/v1/auth/register')
        .send({ email: 'ada@example.com' });
      expect(response.status).toBe(422);
    }

    const response = await request(testApp.app)
      .post('/v1/auth/register')
      .send({ email: 'ada@example.com' });

    expect(response.status).toBe(429);
    expect(response.headers['ratelimit-limit']).toBe(String(emailLimit));
  });

  it('limits refresh by the presented token too', async () => {
    const tokenLimit = readLimit(REFRESH_POLICY, 'refresh-token');
    for (let index = 0; index < tokenLimit; index += 1) {
      const response = await request(testApp.app)
        .post('/v1/auth/refresh')
        .send({ refreshToken: 'a-token-that-does-not-exist' });
      expect(response.status).toBe(401);
    }

    const response = await request(testApp.app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: 'a-token-that-does-not-exist' });

    expect(response.status).toBe(429);
    expect(response.headers['ratelimit-limit']).toBe(String(tokenLimit));
  });

  it('does not limit the signed-in user endpoint or the key set', async () => {
    for (let index = 0; index < readIpLimit(LOGIN_POLICY) + 1; index += 1) {
      const response = await request(testApp.app).get('/.well-known/jwks.json');
      expect(response.status).toBe(200);
    }
  });

  it('refuses register and login with 503 when the limiter is down', async () => {
    limiter.failure = new Error('connection is closed');

    const register = await request(testApp.app).post('/v1/auth/register').send({});
    const login = await request(testApp.app).post('/v1/auth/login').send({});

    expect(register.status).toBe(503);
    expect(login.status).toBe(503);
    expect(register.headers['retry-after']).toBe(
      String(RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
  });

  it('lets refresh and logout through when the limiter is down', async () => {
    limiter.failure = new Error('connection is closed');

    const refresh = await request(testApp.app).post('/v1/auth/refresh').send({});
    const logout = await request(testApp.app).post('/v1/auth/logout').send({});

    expect(refresh.status).toBe(422);
    expect(logout.status).toBe(422);
  });
});
