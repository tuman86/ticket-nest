import { randomUUID } from 'node:crypto';

import { createErrorHandler, handleUnmatchedRoute } from '@ticketnest/errors/express';
import { createLogger } from '@ticketnest/logger';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { type AccessTokenVerifier } from '@/access-token-verifier';
import { type AuthenticatedPrincipal } from '@/authenticated-principal';
import { findAuthenticatedPrincipal } from '@/express/authenticated-principal-accessors';
import { createOptionalAuthenticateMiddleware } from '@/express/optional-authenticate-middleware';
import { InvalidAccessTokenError } from '@/invalid-access-token.error';
import { KeySetUnavailableError } from '@/key-resolver';

const TOKEN = 'header.payload.signature';
const OK = 200;
const UNAUTHORIZED = 401;
const SERVICE_UNAVAILABLE = 503;
const TEST_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const TEST_RATE_LIMIT_REQUESTS = 1000;

const PRINCIPAL: AuthenticatedPrincipal = {
  userId: randomUUID(),
  roleKey: 'OPERATOR',
  permissions: [],
  tenantId: randomUUID(),
  authTime: new Date(0),
  tokenId: randomUUID(),
};

/**
 * @param verify - What the fake verifier does.
 * @returns An app with one route behind the optional middleware that echoes who the caller is,
 * or that nobody is signed in, and the shared error handler.
 */
function buildApp(verify: AccessTokenVerifier['verify']): Express {
  const logger = createLogger({ serviceName: 'test', level: 'silent', nodeEnvironment: 'test' });
  const app = express();
  // See authenticate-middleware.test.ts: CodeQL only recognises libraries like express-rate-limit.
  app.use(
    rateLimit({
      windowMs: TEST_RATE_LIMIT_WINDOW_MS,
      limit: TEST_RATE_LIMIT_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  const authenticate = createOptionalAuthenticateMiddleware({ verifier: { verify }, logger });
  app.get('/search', authenticate, (_, res) => {
    const principal = findAuthenticatedPrincipal(res);
    res.json({ userId: principal?.userId ?? null });
  });
  app.use(handleUnmatchedRoute);
  app.use(
    createErrorHandler({
      logger,
      getCorrelationId: () => 'test-correlation-id',
      isDebugInfoExposed: false,
    }),
  );
  return app;
}

describe('createOptionalAuthenticateMiddleware', () => {
  it('lets a request with no Authorization header through as anonymous, without verifying', async () => {
    const verify = vi.fn<AccessTokenVerifier['verify']>();

    const response = await request(buildApp(verify)).get('/search');

    expect(response.status).toBe(OK);
    expect(response.body).toEqual({ userId: null });
    expect(verify).not.toHaveBeenCalled();
  });

  it('verifies a Bearer token and gives the handler the caller', async () => {
    const verify = vi.fn<AccessTokenVerifier['verify']>().mockResolvedValue(PRINCIPAL);

    const response = await request(buildApp(verify))
      .get('/search')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(OK);
    expect(response.body).toEqual({ userId: PRINCIPAL.userId });
    expect(verify).toHaveBeenCalledExactlyOnceWith(TOKEN);
  });

  it('answers 401 for an invalid token instead of silently treating the caller as anonymous', async () => {
    const verify = vi.fn().mockRejectedValue(new InvalidAccessTokenError('expired'));

    const response = await request(buildApp(verify))
      .get('/search')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(UNAUTHORIZED);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it.each([
    ['another scheme', `Basic ${TOKEN}`],
    ['a token with a space in it', 'Bearer a b'],
    ['an empty token', 'Bearer '],
  ])('answers 401 for %s, without calling the verifier', async (_name, value) => {
    const verify = vi.fn<AccessTokenVerifier['verify']>();

    const response = await request(buildApp(verify)).get('/search').set('Authorization', value);

    expect(response.status).toBe(UNAUTHORIZED);
    expect(verify).not.toHaveBeenCalled();
  });

  it('lets a key set outage reach the error handler as a 503, never a 401', async () => {
    const verify = vi.fn().mockRejectedValue(new KeySetUnavailableError());

    const response = await request(buildApp(verify))
      .get('/search')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(SERVICE_UNAVAILABLE);
  });
});
