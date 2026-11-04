import { GatewayTimeoutError } from '@ticketnest/errors';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { UndiciUpstreamClient } from '@/proxy/undici-upstream-client';
import { type RateLimitPolicy } from '@ticketnest/rate-limit';

import { mintAccessToken } from '../../support/mint-access-token';
import { createTestApp } from '../../support/create-test-app';
import {
  findClosedOrigin,
  startLoopbackUpstream,
  type LoopbackUpstream,
} from '../../support/loopback-upstream';

const PROBLEM_JSON = /application\/problem\+json/;
const LOGIN_BODY = { email: 'ada@example.com', password: 'correct horse battery' };
const WINDOW_MS = 60_000;

/**
 * @param name - Policy name, so the Redis keys of the two policies stay apart.
 * @param scope - What the single rule counts by.
 * @param limit - Requests allowed per window.
 * @returns A fail-open policy with one rule.
 */
function createPolicy(name: string, scope: string, limit: number): RateLimitPolicy {
  return { name, failureMode: 'fail-open', rules: [{ scope, limit, windowMs: WINDOW_MS }] };
}

describe('a public route', () => {
  it('passes the request to the service and the answer back, with no token', async () => {
    const { app, upstream } = createTestApp();
    upstream.enqueue({
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ accessToken: 'opaque-for-this-test' }),
    });

    const response = await request(app).post('/v1/auth/login').send(LOGIN_BODY);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accessToken: 'opaque-for-this-test' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      upstream: 'auth',
      method: 'POST',
      pathAndQuery: '/v1/auth/login',
    });
    expect(JSON.parse(upstream.requests[0]?.bodyText ?? '')).toEqual(LOGIN_BODY);
  });

  it('never reads the token, so a stale one in the header does not block a login', async () => {
    const { app, upstream } = createTestApp();

    const response = await request(app)
      .post('/v1/auth/login')
      .set('Authorization', 'Bearer not.a.valid.token')
      .send(LOGIN_BODY);

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });

  it("passes the service's own error through unchanged", async () => {
    const { app, upstream } = createTestApp();
    upstream.enqueue({
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
      body: JSON.stringify({ status: 401, code: 'INVALID_CREDENTIALS' }),
    });

    const response = await request(app).post('/v1/auth/login').send(LOGIN_BODY);

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

describe('an optional route', () => {
  it('serves an anonymous caller and keeps the query string', async () => {
    const { app, upstream } = createTestApp();

    const response = await request(app).get('/v1/search?q=dune&limit=5');

    expect(response.status).toBe(200);
    expect(upstream.requests[0]).toMatchObject({
      upstream: 'catalog',
      pathAndQuery: '/v1/search?q=dune&limit=5',
    });
    expect(upstream.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('answers 401 for a token that is sent but expired, instead of serving it as anonymous', async () => {
    const { app, upstream } = createTestApp();
    const token = await mintAccessToken({
      issuedAt: new Date(Date.now() - 3_600_000),
      lifetimeSeconds: 60,
    });

    const response = await request(app).get('/v1/search').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe('a protected route without a token', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a token that is not a JWT', 'Bearer abc'],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
  ])('answers 401 problem+json for %s and never reaches the service', async (_name, header) => {
    const { app, upstream } = createTestApp();
    const call = request(app).get('/v1/users/me');

    const response = await (header === undefined ? call : call.set('Authorization', header));

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(upstream.requests).toHaveLength(0);
  });

  it('treats a route that no rule lists as protected', async () => {
    const { app, upstream } = createTestApp();

    const response = await request(app).post('/v1/schedules').send({});

    expect(response.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe('a protected route with a valid token', () => {
  it('forwards the token unchanged, so the service can verify it again', async () => {
    const { app, upstream } = createTestApp();
    const token = await mintAccessToken();

    const response = await request(app).get('/v1/users/me').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(upstream.requests[0]).toMatchObject({ upstream: 'auth', pathAndQuery: '/v1/users/me' });
  });

  it('forwards a body for a write and the headers that matter to it', async () => {
    const { app, upstream } = createTestApp();
    const token = await mintAccessToken();

    await request(app)
      .patch('/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/merge-patch+json')
      .set('If-Match', '"v3"')
      .set('Idempotency-Key', 'key-1')
      .send(JSON.stringify({ displayName: 'Ada' }));

    expect(upstream.requests[0]).toMatchObject({
      method: 'PATCH',
      bodyText: '{"displayName":"Ada"}',
      headers: {
        'content-type': 'application/merge-patch+json',
        'if-match': '"v3"',
        'idempotency-key': 'key-1',
      },
    });
  });
});

describe('spoofed identity and forwarding headers', () => {
  it('never reach the service', async () => {
    const { app, upstream } = createTestApp();
    const token = await mintAccessToken();

    await request(app)
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-User-Id', '00000000-0000-4000-8000-000000000001')
      .set('X-Tenant-Id', 'tenant-of-someone-else')
      .set('X-Role', 'ADMIN')
      .set('X-Forwarded-User', 'admin')
      .set('X-Forwarded-Host', 'evil.example')
      .set('Cookie', 'session=stolen')
      .set('X-Forwarded-For', '6.6.6.6');

    const received = upstream.requests[0]?.headers ?? {};
    expect(Object.keys(received).sort()).toEqual(
      [
        'authorization',
        'x-forwarded-for',
        'x-forwarded-proto',
        'x-request-id',
        // supertest sends these by default
        'accept-encoding',
        'user-agent',
      ]
        .filter((name) => name in received)
        .sort(),
    );
    expect(received['x-forwarded-for']).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    expect(JSON.stringify(received)).not.toMatch(/6\.6\.6\.6|stolen|evil|ADMIN|tenant-of/);
  });

  it('are replaced by the single address the gateway resolved when one proxy hop is trusted', async () => {
    const { app, upstream } = createTestApp({ appOverrides: { trustProxyHops: 1 } });

    await request(app).get('/v1/search').set('X-Forwarded-For', '198.51.100.9, 203.0.113.50');

    expect(upstream.requests[0]?.headers['x-forwarded-for']).toBe('203.0.113.50');
  });

  it('keep a safe client request id and replace an unsafe one', async () => {
    const { app, upstream } = createTestApp();

    await request(app).get('/v1/search').set('X-Request-Id', 'web-42');
    await request(app).get('/v1/search').set('X-Request-Id', 'bad id!');

    expect(upstream.requests[0]?.headers['x-request-id']).toBe('web-42');
    expect(upstream.requests[1]?.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('are also dropped from what the service sends back, so a service cannot widen CORS', async () => {
    const { app, upstream } = createTestApp();
    upstream.enqueue({
      headers: {
        'content-type': 'application/json',
        'x-powered-by': 'Express',
        server: 'internal-1',
        'access-control-allow-origin': '*',
        'x-request-id': 'from-the-service',
        etag: '"v1"',
      },
    });

    const response = await request(app).get('/v1/search');

    expect(response.headers.etag).toBe('"v1"');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers.server).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['x-request-id']).not.toBe('from-the-service');
  });
});

describe('rate limiting', () => {
  it('answers 429 problem+json with Retry-After once an IP is over its limit', async () => {
    const { app, upstream } = createTestApp({ ipPolicy: createPolicy('gateway-ip', 'ip', 2) });

    const first = await request(app).get('/v1/search');
    const second = await request(app).get('/v1/search');
    const third = await request(app).get('/v1/search');

    expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
    expect(third.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(third.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(third.headers['ratelimit-limit']).toBe('2');
    expect(third.headers['ratelimit-remaining']).toBe('0');
    expect(third.body).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(upstream.requests).toHaveLength(2);
  });

  it('counts a signed-in user on their own, whatever the IP rule says', async () => {
    const { app, upstream } = createTestApp({
      userPolicy: createPolicy('gateway-user', 'user', 1),
    });
    const ada = await mintAccessToken();
    const grace = await mintAccessToken();

    const adaFirst = await request(app).get('/v1/users/me').set('Authorization', `Bearer ${ada}`);
    const adaSecond = await request(app).get('/v1/users/me').set('Authorization', `Bearer ${ada}`);
    const graceFirst = await request(app)
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${grace}`);

    expect([adaFirst.status, adaSecond.status, graceFirst.status]).toEqual([200, 429, 200]);
    expect(adaSecond.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(upstream.requests).toHaveLength(2);
  });

  it('does not count an anonymous request against the user limit', async () => {
    const { app } = createTestApp({ userPolicy: createPolicy('gateway-user', 'user', 1) });

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await request(app).get('/v1/search')).status);
    }

    expect(statuses).toEqual([200, 200, 200]);
  });

  it('lets traffic through, with a warning, when the limiter is down', async () => {
    const { app, upstream, limiter, lines } = createTestApp();
    limiter.failure = new Error('connection is closed');

    const response = await request(app).get('/v1/search');

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', policy: 'gateway-ip' }));
  });
});

describe('an upstream that does not answer', () => {
  let slowUpstream: LoopbackUpstream | undefined;

  afterEach(async () => {
    await slowUpstream?.close();
    slowUpstream = undefined;
  });

  it('answers 504 problem+json when the service times out', async () => {
    const { app, upstream, lines } = createTestApp();
    upstream.enqueue(new GatewayTimeoutError({ cause: new Error('headers timeout at 10.0.0.7') }));

    const response = await request(app).get('/v1/search');

    expect(response.status).toBe(504);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.body).toMatchObject({ status: 504, code: 'GATEWAY_TIMEOUT' });
    expect(response.body).not.toHaveProperty('detail');
    expect(response.text).not.toContain('10.0.0.7');
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'request failed' }),
    );
  });

  it('answers 504 over a real socket when the service never sends a response', async () => {
    slowUpstream = await startLoopbackUpstream(() => undefined);
    const upstreamClient = new UndiciUpstreamClient({
      origins: { auth: slowUpstream.origin, catalog: slowUpstream.origin },
      headersTimeoutMs: 100,
    });
    const { app } = createTestApp({ upstreamClient });

    const response = await request(app).get('/v1/search');

    expect(response.status).toBe(504);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.body).toMatchObject({ code: 'GATEWAY_TIMEOUT' });
    await upstreamClient.close();
  });

  it('answers 502 problem+json when nothing listens at the service', async () => {
    const origin = await findClosedOrigin();
    const upstreamClient = new UndiciUpstreamClient({ origins: { auth: origin, catalog: origin } });
    const { app } = createTestApp({ upstreamClient });

    const response = await request(app).post('/v1/auth/login').send(LOGIN_BODY);

    expect(response.status).toBe(502);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.body).toMatchObject({ code: 'BAD_GATEWAY' });
    await upstreamClient.close();
  });

  it('answers 503 with Retry-After at once, without calling the service, after repeated failures', async () => {
    const { app, upstream } = createTestApp({ circuitFailureThreshold: 2 });
    upstream.alwaysRespond(new GatewayTimeoutError());

    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await request(app).post('/v1/auth/login').send(LOGIN_BODY)).status);
    }
    const refused = await request(app).post('/v1/auth/login').send(LOGIN_BODY);

    expect(statuses).toEqual([504, 504, 503, 503]);
    expect(refused.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(refused.body).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(upstream.requests).toHaveLength(2);
  });
});

describe('requests the gateway refuses itself', () => {
  it('answers 404 problem+json for a path no service owns, without calling a service', async () => {
    const { app, upstream } = createTestApp();

    const response = await request(app).get('/.well-known/jwks.json');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(upstream.requests).toHaveLength(0);
  });

  it('does not match a prefix inside a longer name', async () => {
    const { app, upstream } = createTestApp();

    const response = await request(app).get('/v1/authentic');

    expect(response.status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it.each([
    '/v1/search/../users/me',
    '/v1/search/%2e%2e/users/me',
    '/v1/search/a%2fb',
    '/v1/search/%zz',
  ])('answers 400 for the path %s instead of forwarding it', async (path) => {
    const { app, upstream } = createTestApp();

    const response = await request(app).get(path);

    expect(response.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it('answers 413 when the declared body is over the limit, without calling a service', async () => {
    const { app, upstream } = createTestApp({ maxRequestBodyBytes: 100 });

    const response = await request(app)
      .post('/v1/auth/register')
      .send({ filler: 'x'.repeat(500) });

    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(upstream.requests).toHaveLength(0);
  });

  it('does not forward a body on a GET', async () => {
    const { app, upstream } = createTestApp();

    await request(app).get('/v1/search').send({ sneaky: true });

    expect(upstream.requests[0]?.bodyText).toBeNull();
  });
});
