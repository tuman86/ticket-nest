import { randomUUID } from 'node:crypto';

import { createErrorHandler, handleUnmatchedRoute } from '@ticketnest/errors/express';
import { createLogger, type Logger } from '@ticketnest/logger';
import express, { type Express, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { describe, expect, it, vi, type MockInstance } from 'vitest';

import { AUTHORIZATION_HEADER_MAX_LENGTH } from '@/access-token-constants';
import { type AccessTokenVerifier } from '@/access-token-verifier';
import { type AuthenticatedPrincipal } from '@/authenticated-principal';
import { createAuthenticateMiddleware } from '@/express/authenticate-middleware';
import { getAuthenticatedPrincipal } from '@/express/authenticated-principal-accessors';
import { InvalidAccessTokenError } from '@/invalid-access-token.error';
import { KeySetUnavailableError } from '@/key-resolver';

const TOKEN = 'header.payload.signature';
const OK = 200;
const UNAUTHORIZED = 401;
const INTERNAL_SERVER_ERROR = 500;
const SERVICE_UNAVAILABLE = 503;
const TEST_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const TEST_RATE_LIMIT_REQUESTS = 1000;

const PRINCIPAL: AuthenticatedPrincipal = {
  userId: randomUUID(),
  roleKey: 'CUSTOMER',
  permissions: [],
  tenantId: null,
  authTime: new Date(0),
  tokenId: randomUUID(),
};

/**
 * @param verify - What the fake verifier does.
 * @returns An app with one protected route that echoes the caller, one route with no middleware
 * that reads the caller anyway, and the shared error handler.
 */
function buildApp(verify: AccessTokenVerifier['verify']): {
  app: Express;
  info: MockInstance<Logger['info']>;
} {
  const logger = createLogger({ serviceName: 'test', level: 'silent', nodeEnvironment: 'test' });
  const info = vi.spyOn(logger, 'info');
  const app = express();
  // The routes below are fixtures, so nothing here needs rate limiting. This limiter exists because
  // CodeQL's js/missing-rate-limiting query only recognises libraries like express-rate-limit and
  // flags any route behind the authenticate middleware without one. Its limit is far above what the
  // tests send, so it never answers 429.
  app.use(
    rateLimit({
      windowMs: TEST_RATE_LIMIT_WINDOW_MS,
      limit: TEST_RATE_LIMIT_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  const authenticate = createAuthenticateMiddleware({ verifier: { verify }, logger });
  app.get('/protected', authenticate, (_, res) => {
    res.json({ userId: getAuthenticatedPrincipal(res).userId });
  });
  app.get('/forgot-middleware', (_, res: Response) => {
    res.json({ userId: getAuthenticatedPrincipal(res).userId });
  });
  app.use(handleUnmatchedRoute);
  app.use(
    createErrorHandler({
      logger,
      getCorrelationId: () => 'test-correlation-id',
      isDebugInfoExposed: false,
    }),
  );
  return { app, info };
}

describe('createAuthenticateMiddleware', () => {
  it('verifies the Bearer token and gives the handler the caller', async () => {
    const verify = vi.fn<AccessTokenVerifier['verify']>().mockResolvedValue(PRINCIPAL);
    const { app } = buildApp(verify);

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(OK);
    expect(response.body).toEqual({ userId: PRINCIPAL.userId });
    expect(verify).toHaveBeenCalledExactlyOnceWith(TOKEN);
  });

  it('accepts the scheme in any letter case', async () => {
    const verify = vi.fn<AccessTokenVerifier['verify']>().mockResolvedValue(PRINCIPAL);
    const { app } = buildApp(verify);

    const response = await request(app).get('/protected').set('Authorization', `bearer ${TOKEN}`);

    expect(response.status).toBe(OK);
  });

  describe('answers one identical 401 problem', () => {
    const header = (value: string | undefined) =>
      value === undefined ? {} : { Authorization: value };

    it.each([
      ['no Authorization header', undefined],
      ['another scheme', `Basic ${TOKEN}`],
      ['a token with a space in it', 'Bearer a b'],
      ['an empty token', 'Bearer '],
      ['a header longer than the limit', `Bearer ${'a'.repeat(AUTHORIZATION_HEADER_MAX_LENGTH)}`],
    ])('for %s, without calling the verifier', async (_name, value) => {
      const verify = vi.fn<AccessTokenVerifier['verify']>();
      const { app } = buildApp(verify);

      const response = await request(app).get('/protected').set(header(value));

      expect(response.status).toBe(UNAUTHORIZED);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(verify).not.toHaveBeenCalled();
    });

    it('whatever the verifier refused, so a caller learns nothing about which check failed', async () => {
      const bodies: unknown[] = [];
      for (const reason of [
        'expired',
        'bad_signature',
        'wrong_audience',
        'unknown_key_id',
      ] as const) {
        const { app } = buildApp(vi.fn().mockRejectedValue(new InvalidAccessTokenError(reason)));
        const response = await request(app)
          .get('/protected')
          .set('Authorization', `Bearer ${TOKEN}`);
        expect(response.status).toBe(UNAUTHORIZED);
        bodies.push(response.body);
      }

      expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    });
  });

  it('logs the reason a token was refused, and never the token', async () => {
    const { app, info } = buildApp(
      vi.fn().mockRejectedValue(new InvalidAccessTokenError('wrong_issuer')),
    );

    await request(app).get('/protected').set('Authorization', `Bearer ${TOKEN}`);

    expect(info).toHaveBeenCalledWith({ reason: 'wrong_issuer' }, 'access token rejected');
    expect(JSON.stringify(info.mock.calls)).not.toContain(TOKEN);
  });

  it('lets a key set outage reach the error handler as a 503, never a 401', async () => {
    const { app } = buildApp(vi.fn().mockRejectedValue(new KeySetUnavailableError()));

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(SERVICE_UNAVAILABLE);
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('lets an unexpected error reach the error handler as a 500', async () => {
    const { app } = buildApp(vi.fn().mockRejectedValue(new Error('boom')));

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(INTERNAL_SERVER_ERROR);
  });
});

describe('getAuthenticatedPrincipal', () => {
  it('fails with a 500 when the route has no authentication middleware', async () => {
    const { app } = buildApp(vi.fn());

    const response = await request(app).get('/forgot-middleware');

    expect(response.status).toBe(INTERNAL_SERVER_ERROR);
  });
});
