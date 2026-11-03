import { ServiceUnavailableError, TooManyRequestsError } from '@ticketnest/errors';
import { beforeEach, describe, expect, it } from 'vitest';

import { RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS } from '@/rate-limit/rate-limit-constants';
import { RateLimitService } from '@/rate-limit/rate-limit.service';
import {
  LOGIN_POLICY,
  LOGOUT_POLICY,
  REFRESH_POLICY,
  REGISTER_POLICY,
  type RateLimitPolicy,
} from '@/rate-limit/rate-limit-policies';

import { InMemoryRateLimiter } from '../../support/in-memory-rate-limiter';
import { createTestApp, type LogLine } from '../../support/create-test-app';

const PEPPER = 'a-test-pepper-that-is-long-enough-1';
const EMAIL = 'ada@example.com';
const REFRESH_TOKEN = 'refresh-token-value-0123456789';
const IP = '203.0.113.7';
const START_MS = Date.UTC(2026, 10, 3, 12, 0, 0);
const HANG_TIMEOUT_MS = 20;
const SECOND_MS = 1_000;

/** Rule limits of the login policy, read from the policy so these tests follow its constants. */
const IP_LIMIT = LOGIN_POLICY.rules[0]?.limit ?? 0;
const EMAIL_LIMIT = LOGIN_POLICY.rules[1]?.limit ?? 0;
const WINDOW_MS = LOGIN_POLICY.rules[0]?.windowMs ?? 0;

let nowMs: number;
let limiter: InMemoryRateLimiter;
let lines: LogLine[];
let service: RateLimitService;

/**
 * Sends `count` login checks, each with its own email or IP as the test needs.
 *
 * @param count - How many checks to run.
 * @param identifiers - Builds the identifiers of check number `index`.
 */
async function checkLoginTimes(
  count: number,
  identifiers: (index: number) => { ip: string; email: string },
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await service.check(LOGIN_POLICY, identifiers(index));
  }
}

/**
 * Runs a call that is expected to reject and hands back what it rejected with.
 *
 * @param action - The call under test.
 * @returns The error it rejected with. The test fails if the call resolves.
 */
async function captureError(action: () => Promise<void>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return expect.unreachable('expected the call to reject');
}

beforeEach(() => {
  nowMs = START_MS;
  limiter = new InMemoryRateLimiter(() => new Date(nowMs));
  const testApp = createTestApp();
  lines = testApp.lines;
  service = new RateLimitService({
    rateLimiter: limiter,
    keyPepper: PEPPER,
    logger: testApp.logger,
    timeoutMs: HANG_TIMEOUT_MS,
  });
});

describe('RateLimitService.check', () => {
  describe('under and at the limit', () => {
    it('allows requests under the limit', async () => {
      await expect(
        checkLoginTimes(EMAIL_LIMIT - 1, () => ({ ip: IP, email: EMAIL })),
      ).resolves.toBeUndefined();
    });

    it('allows the request that reaches the limit and denies the next one', async () => {
      await checkLoginTimes(EMAIL_LIMIT, () => ({ ip: IP, email: EMAIL }));

      const error = await captureError(() => service.check(LOGIN_POLICY, { ip: IP, email: EMAIL }));

      expect(error).toBeInstanceOf(TooManyRequestsError);
      expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    });
  });

  describe('429 with Retry-After', () => {
    it('reports the limit that was hit and the seconds until its window ends', async () => {
      await checkLoginTimes(EMAIL_LIMIT, () => ({ ip: IP, email: EMAIL }));
      const fiveMinutesMs = 5 * 60 * SECOND_MS;
      nowMs += fiveMinutesMs;

      const error = await captureError(() => service.check(LOGIN_POLICY, { ip: IP, email: EMAIL }));

      const remainingSeconds = String((WINDOW_MS - fiveMinutesMs) / SECOND_MS);
      expect(error).toBeInstanceOf(TooManyRequestsError);
      expect((error as TooManyRequestsError).headers).toEqual({
        'Retry-After': remainingSeconds,
        'RateLimit-Limit': String(EMAIL_LIMIT),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': remainingSeconds,
      });
    });

    it('rounds a part of a second up and never answers 0', async () => {
      await checkLoginTimes(EMAIL_LIMIT, () => ({ ip: IP, email: EMAIL }));
      nowMs += WINDOW_MS - 1;

      const error = await captureError(() => service.check(LOGIN_POLICY, { ip: IP, email: EMAIL }));

      expect((error as TooManyRequestsError).headers['Retry-After']).toBe('1');
    });
  });

  describe('reset after the window', () => {
    it('allows requests again once the window has passed', async () => {
      await checkLoginTimes(EMAIL_LIMIT, () => ({ ip: IP, email: EMAIL }));
      await expect(service.check(LOGIN_POLICY, { ip: IP, email: EMAIL })).rejects.toBeInstanceOf(
        TooManyRequestsError,
      );

      nowMs += WINDOW_MS;

      await expect(service.check(LOGIN_POLICY, { ip: IP, email: EMAIL })).resolves.toBeUndefined();
    });
  });

  describe('both keys apply', () => {
    it('denies when the IP is over its limit, whatever the email', async () => {
      await checkLoginTimes(IP_LIMIT, (index) => ({
        ip: IP,
        email: `user-${String(index)}@example.com`,
      }));

      const error = await captureError(() =>
        service.check(LOGIN_POLICY, { ip: IP, email: 'fresh@example.com' }),
      );

      expect(error).toBeInstanceOf(TooManyRequestsError);
      expect((error as TooManyRequestsError).headers['RateLimit-Limit']).toBe(String(IP_LIMIT));
    });

    it('denies when the email is over its limit, whatever the IP', async () => {
      await checkLoginTimes(EMAIL_LIMIT, (index) => ({
        ip: `198.51.100.${String(index)}`,
        email: EMAIL,
      }));

      const error = await captureError(() =>
        service.check(LOGIN_POLICY, { ip: '198.51.100.200', email: EMAIL }),
      );

      expect(error).toBeInstanceOf(TooManyRequestsError);
      expect((error as TooManyRequestsError).headers['RateLimit-Limit']).toBe(String(EMAIL_LIMIT));
    });

    it('counts every request against both the IP and the email', async () => {
      await service.check(LOGIN_POLICY, { ip: IP, email: EMAIL });

      expect(limiter.consumedKeys).toHaveLength(2);
      expect(limiter.consumedKeys[0]).toContain(':ip:');
      expect(limiter.consumedKeys[1]).toContain(':email:');
    });

    it('stops at the first denial, so a blocked IP cannot burn the email counter', async () => {
      await checkLoginTimes(IP_LIMIT, (index) => ({
        ip: IP,
        email: `user-${String(index)}@example.com`,
      }));
      limiter.consumedKeys.length = 0;

      await expect(service.check(LOGIN_POLICY, { ip: IP, email: EMAIL })).rejects.toBeInstanceOf(
        TooManyRequestsError,
      );

      expect(limiter.consumedKeys).toHaveLength(1);
      expect(limiter.consumedKeys[0]).toContain(':ip:');
    });

    it('skips a rule whose identifier is missing and still applies the IP rule', async () => {
      await service.check(LOGIN_POLICY, { ip: IP });

      expect(limiter.consumedKeys).toHaveLength(1);
      expect(limiter.consumedKeys[0]).toContain(':ip:');
    });

    it('limits a refresh token on its own key', async () => {
      const tokenLimit = REFRESH_POLICY.rules[1]?.limit ?? 0;
      for (let index = 0; index < tokenLimit; index += 1) {
        await service.check(REFRESH_POLICY, {
          ip: `198.51.100.${String(index)}`,
          'refresh-token': REFRESH_TOKEN,
        });
      }

      await expect(
        service.check(REFRESH_POLICY, { ip: '198.51.100.250', 'refresh-token': REFRESH_TOKEN }),
      ).rejects.toBeInstanceOf(TooManyRequestsError);
    });
  });

  describe('when the limiter fails', () => {
    beforeEach(() => {
      limiter.failure = new Error('connection is closed');
    });

    it.each([
      ['register', REGISTER_POLICY],
      ['login', LOGIN_POLICY],
    ])('fails closed on %s with a 503 and Retry-After', async (_name, policy) => {
      const error = await captureError(() => service.check(policy, { ip: IP, email: EMAIL }));

      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect(error).toMatchObject({
        status: 503,
        headers: { 'Retry-After': String(RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS) },
      });
    });

    it.each([
      ['refresh', REFRESH_POLICY],
      ['logout', LOGOUT_POLICY],
    ])('fails open on %s and logs a warning', async (name, policy) => {
      await expect(
        service.check(policy, { ip: IP, 'refresh-token': REFRESH_TOKEN }),
      ).resolves.toBeUndefined();

      expect(lines).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          policy: name,
          msg: 'rate limiter unavailable, request allowed',
        }),
      );
    });

    it('treats a limiter that throws before returning a promise like any other failure', async () => {
      const throwingService = new RateLimitService({
        rateLimiter: {
          consume: () => {
            throw new Error('not async');
          },
        },
        keyPepper: PEPPER,
        logger: createTestApp().logger,
      });

      await expect(
        throwingService.check(LOGIN_POLICY, { ip: IP, email: EMAIL }),
      ).rejects.toBeInstanceOf(ServiceUnavailableError);
      await expect(throwingService.check(LOGOUT_POLICY, { ip: IP })).resolves.toBeUndefined();
    });

    it('treats a limiter that never answers like a failure, after the timeout', async () => {
      limiter.failure = undefined;
      limiter.isHanging = true;

      await expect(service.check(LOGIN_POLICY, { ip: IP, email: EMAIL })).rejects.toBeInstanceOf(
        ServiceUnavailableError,
      );
      await expect(service.check(LOGOUT_POLICY, { ip: IP })).resolves.toBeUndefined();
    });
  });

  describe('what is stored and logged', () => {
    it('keeps the email, the refresh token and the pepper out of the keys', async () => {
      await service.check(LOGIN_POLICY, { ip: IP, email: EMAIL });
      await service.check(REFRESH_POLICY, { ip: IP, 'refresh-token': REFRESH_TOKEN });

      const keys = limiter.consumedKeys.join('\n');
      expect(keys).not.toContain(EMAIL);
      expect(keys).not.toContain(REFRESH_TOKEN);
      expect(keys).not.toContain(PEPPER);
    });

    it('logs a denial and a failure with the policy only, never an identifier or a key', async () => {
      await checkLoginTimes(EMAIL_LIMIT + 1, () => ({ ip: IP, email: EMAIL })).catch(
        () => undefined,
      );
      limiter.failure = new Error('connection is closed');
      await service.check(LOGIN_POLICY, { ip: IP, email: EMAIL }).catch(() => undefined);

      const logged = JSON.stringify(lines);
      expect(logged).toContain('rate limit exceeded');
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain(IP);
      expect(logged).not.toContain('rl:v1');
      expect(logged).not.toContain(PEPPER);
    });
  });
});

describe('a custom policy', () => {
  it('follows the rules it is given, in order', async () => {
    const policy: RateLimitPolicy = {
      name: 'login',
      failureMode: 'fail-closed',
      rules: [{ scope: 'ip', limit: 1, windowMs: SECOND_MS }],
    };

    await service.check(policy, { ip: IP });

    await expect(service.check(policy, { ip: IP })).rejects.toBeInstanceOf(TooManyRequestsError);
  });
});
