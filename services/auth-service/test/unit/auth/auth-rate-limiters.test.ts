import { Router, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthRateLimiters } from '@/auth/auth-rate-limiters';
import { RateLimitService } from '@/rate-limit/rate-limit.service';

import { createTestApp } from '../../support/create-test-app';
import { InMemoryRateLimiter } from '../../support/in-memory-rate-limiter';

const PEPPER = 'a-test-pepper-that-is-long-enough-1';

describe('createAuthRateLimiters', () => {
  it.each(['register', 'login', 'refresh', 'logout'] as const)(
    'counts a request on the %s limiter against the %s policy',
    async (name) => {
      const limiter = new InMemoryRateLimiter();
      const { app } = createTestApp(
        {},
        {
          buildRouters: (logger) => {
            const limiters = createAuthRateLimiters({
              rateLimitService: new RateLimitService({
                rateLimiter: limiter,
                keyPepper: PEPPER,
                logger,
              }),
            });
            /**
             * Ends the request, so a 204 shows the limiter let it through.
             *
             * @param _request - Unused.
             * @param response - Answered with 204.
             */
            const handler: RequestHandler = (_request, response) => {
              response.status(204).end();
            };
            const router = Router();
            router.post('/probe', limiters[name], handler);
            return [router];
          },
        },
      );

      const response = await request(app).post('/probe').send({});

      expect(response.status).toBe(204);
      expect(limiter.consumedKeys[0]).toMatch(new RegExp(`^rl:v1:${name}:ip:`));
    },
  );
});
