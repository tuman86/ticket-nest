import { NotFoundError } from '@ticketnest/errors';
import { getCorrelationId } from '@ticketnest/logger';
import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createTestApp } from '../../support/create-test-app';

const ALLOWED_ORIGIN = 'https://app.ticketnest.example';

function createProbeRouter(): Router {
  const router = Router();
  router.post('/probe/echo', (httpRequest, response) => {
    // Read after the body parser, which is where request-scoped context tends to get lost.
    response.json({ body: httpRequest.body as unknown, correlationId: getCorrelationId() });
  });
  router.get('/probe/missing', () => {
    throw new NotFoundError({ detail: 'Nothing here.' });
  });
  router.get('/probe/crash', () => {
    throw new Error('connect ECONNREFUSED postgres://auth_service:hunter2@db');
  });
  return router;
}

describe('request id', () => {
  it('echoes a safe incoming X-Request-Id', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/health/live').set('X-Request-Id', 'gateway-42');

    expect(response.headers['x-request-id']).toBe('gateway-42');
  });

  it.each(['bad id!', 'x'.repeat(129)])(
    'replaces the unsafe id %j with a generated one',
    async (id) => {
      const { app } = createTestApp();

      const response = await request(app).get('/health/live').set('X-Request-Id', id);

      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('generates an id when none is sent', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/health/live');

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the correlation context after the JSON body is parsed', async () => {
    const { app } = createTestApp({ routers: [createProbeRouter()] });

    const response = await request(app)
      .post('/probe/echo')
      .set('X-Request-Id', 'ctx-1')
      .send({ hello: 'world' });

    expect(response.body).toEqual({ body: { hello: 'world' }, correlationId: 'ctx-1' });
  });
});

describe('request logging', () => {
  it('logs one line per request with the correlation id and no query string', async () => {
    const { app, lines } = createTestApp({ routers: [createProbeRouter()] });

    await request(app).get('/probe/missing?token=abc123').set('X-Request-Id', 'log-1');

    const completed = lines.filter((line) => line.msg === 'request completed');
    expect(completed).toEqual([
      expect.objectContaining({
        service: 'auth-service',
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
    const { app, lines } = createTestApp();

    await request(app).get('/health/live');

    expect(lines.find((line) => line.msg === 'request completed')).toMatchObject({
      level: 'debug',
      path: '/health/live',
    });
  });
});

describe('security headers and CORS', () => {
  it('sets Helmet headers and hides the framework', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/health/live');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('allows a listed origin', async () => {
    const { app } = createTestApp({ corsOrigins: [ALLOWED_ORIGIN] });

    const response = await request(app).get('/health/live').set('Origin', ALLOWED_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('denies an origin that is not listed', async () => {
    const { app } = createTestApp({ corsOrigins: [ALLOWED_ORIGIN] });

    const response = await request(app).get('/health/live').set('Origin', 'https://evil.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('denies every origin when none is configured', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/health/live').set('Origin', ALLOWED_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('errors', () => {
  it('rejects a body over the limit with 413 problem+json', async () => {
    const { app } = createTestApp({ routers: [createProbeRouter()] });

    const response = await request(app)
      .post('/probe/echo')
      .send({ filler: 'x'.repeat(2_000) });

    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('answers an unknown route with a 404 problem', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/v1/nothing');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', instance: '/v1/nothing' });
  });

  it('maps a thrown AppError to its status', async () => {
    const { app } = createTestApp({ routers: [createProbeRouter()] });

    const response = await request(app).get('/probe/missing');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Nothing here.' });
  });

  it('answers an unexpected error with a generic 500 and logs it with the correlation id', async () => {
    const { app, lines } = createTestApp({ routers: [createProbeRouter()] });

    const response = await request(app).get('/probe/crash').set('X-Request-Id', 'crash-1');

    expect(response.status).toBe(500);
    expect(response.text).not.toMatch(/hunter2|postgres|ECONNREFUSED/);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'request failed', correlationId: 'crash-1' }),
    );
  });
});
