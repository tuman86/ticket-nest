import { NotFoundError } from '@ticketnest/errors';
import { getCorrelationId } from '@ticketnest/logger';
import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createTestApp } from '../../support/create-test-app';

const ALLOWED_ORIGIN = 'https://app.ticketnest.example';

function createProbeRouter(): Router {
  const router = Router();
  router.get('/probe/correlation', (_request, response) => {
    response.json({ correlationId: getCorrelationId() });
  });
  router.get('/probe/missing', () => {
    throw new NotFoundError({ detail: 'Nothing here.' });
  });
  router.get('/probe/crash', () => {
    throw new Error('connect ECONNREFUSED redis://:hunter2@cache');
  });
  router.get('/probe/ip', (httpRequest, response) => {
    response.json({ ip: httpRequest.ip });
  });
  return router;
}

/**
 * @param overrides - App dependencies to replace.
 * @returns The test app with the probe routes mounted instead of the proxy.
 */
function createProbeApp(overrides: Parameters<typeof createTestApp>[0] = {}) {
  return createTestApp({
    ...overrides,
    appOverrides: { routers: [createProbeRouter()], ...overrides.appOverrides },
  });
}

describe('request id', () => {
  it('echoes a safe incoming X-Request-Id', async () => {
    const { app } = createProbeApp();

    const response = await request(app).get('/health/live').set('X-Request-Id', 'web-42');

    expect(response.headers['x-request-id']).toBe('web-42');
  });

  it.each(['bad id!', 'x'.repeat(129)])(
    'replaces the unsafe id %j with a generated one',
    async (id) => {
      const { app } = createProbeApp();

      const response = await request(app).get('/health/live').set('X-Request-Id', id);

      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('generates an id when none is sent', async () => {
    const { app } = createProbeApp();

    const response = await request(app).get('/health/live');

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the correlation context inside a route', async () => {
    const { app } = createProbeApp();

    const response = await request(app).get('/probe/correlation').set('X-Request-Id', 'ctx-1');

    expect(response.body).toEqual({ correlationId: 'ctx-1' });
  });
});

describe('request logging', () => {
  it('logs one line per request with the correlation id and no query string', async () => {
    const { app, lines } = createProbeApp();

    await request(app).get('/probe/missing?token=abc123').set('X-Request-Id', 'log-1');

    const completed = lines.filter((line) => line.msg === 'request completed');
    expect(completed).toEqual([
      expect.objectContaining({
        service: 'api-gateway',
        correlationId: 'log-1',
        method: 'GET',
        path: '/probe/missing',
        status: 404,
        durationMs: expect.any(Number) as unknown,
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('abc123');
  });

  it('logs health probes at debug so they do not flood info', async () => {
    const { app, lines } = createProbeApp();

    await request(app).get('/health/live');

    expect(lines.find((line) => line.msg === 'request completed')).toMatchObject({
      level: 'debug',
      path: '/health/live',
    });
  });
});

describe('security headers and CORS', () => {
  it('sets Helmet headers and hides the framework', async () => {
    const { app } = createProbeApp();

    const response = await request(app).get('/health/live');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('allows a listed origin and exposes the headers a browser app reads', async () => {
    const { app } = createProbeApp({ appOverrides: { corsOrigins: [ALLOWED_ORIGIN] } });

    const response = await request(app).get('/health/live').set('Origin', ALLOWED_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers['access-control-expose-headers']).toBe(
      'ETag,Location,Retry-After,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset,X-Request-Id',
    );
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers a preflight for the headers the apps send, without touching a service', async () => {
    const { app, upstream } = createProbeApp({ appOverrides: { corsOrigins: [ALLOWED_ORIGIN] } });

    const response = await request(app)
      .options('/v1/bookings')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,idempotency-key,content-type');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-headers']).toBe(
      'authorization,idempotency-key,content-type',
    );
    expect(upstream.requests).toHaveLength(0);
  });

  it('denies an origin that is not listed', async () => {
    const { app } = createProbeApp({ appOverrides: { corsOrigins: [ALLOWED_ORIGIN] } });

    const response = await request(app).get('/health/live').set('Origin', 'https://evil.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('denies every origin when none is configured', async () => {
    const { app } = createProbeApp();

    const response = await request(app).get('/health/live').set('Origin', ALLOWED_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('errors', () => {
  it('answers an unknown route with a 404 problem', async () => {
    const { app } = createProbeApp();

    const response = await request(app).get('/v1/nothing');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', instance: '/v1/nothing' });
  });

  it('maps a thrown AppError to its status', async () => {
    const { app } = createProbeApp();

    const response = await request(app).get('/probe/missing');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Nothing here.' });
  });

  it('answers an unexpected error with a generic 500 and logs it with the correlation id', async () => {
    const { app, lines } = createProbeApp();

    const response = await request(app).get('/probe/crash').set('X-Request-Id', 'crash-1');

    expect(response.status).toBe(500);
    expect(response.text).not.toMatch(/hunter2|redis|ECONNREFUSED/);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'request failed', correlationId: 'crash-1' }),
    );
  });
});

describe('client IP behind a proxy', () => {
  const FORWARDED_FOR = '198.51.100.9, 203.0.113.50';

  it('ignores X-Forwarded-For by default, so a client cannot choose its own IP', async () => {
    const { app } = createProbeApp();

    const response = await request(app).get('/probe/ip').set('X-Forwarded-For', FORWARDED_FOR);

    expect((response.body as { ip: string }).ip).toMatch(/127\.0\.0\.1|::1/);
  });

  it('takes the address the nearest trusted proxy saw when one hop is trusted', async () => {
    const { app } = createProbeApp({ appOverrides: { trustProxyHops: 1 } });

    const response = await request(app).get('/probe/ip').set('X-Forwarded-For', FORWARDED_FOR);

    expect((response.body as { ip: string }).ip).toBe('203.0.113.50');
  });
});
