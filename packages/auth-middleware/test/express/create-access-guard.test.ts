import { randomUUID } from 'node:crypto';

import { type PermissionKey } from '@ticketnest/contracts';
import { createErrorHandler, handleUnmatchedRoute } from '@ticketnest/errors/express';
import { createLogger, type Logger } from '@ticketnest/logger';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { describe, expect, it, vi, type MockInstance } from 'vitest';

import { type AuthenticatedPrincipal } from '@/authenticated-principal';
import { getAccessScope } from '@/express/access-scope-accessors';
import { setAuthenticatedPrincipal } from '@/express/authenticated-principal-accessors';
import { createAccessGuard } from '@/express/create-access-guard';
import { InvalidGuardConfigurationError } from '@/invalid-guard-configuration.error';

import { buildPrincipal } from '../support/build-principal';

const OK = 200;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const INTERNAL_SERVER_ERROR = 500;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const TEST_RATE_LIMIT_WINDOW_MS = MINUTE_MS;
const TEST_RATE_LIMIT_REQUESTS = 1000;
const REFUSAL_LOG_MESSAGE = 'access refused';
const TENANT_ID = randomUUID();
const LOGIN_TIME = new Date('2026-11-06T10:00:00.000Z');

/** A clock the test moves by hand, so the age of the login is exact. */
interface ManualClock {
  current: Date;
  readonly now: () => Date;
}

/**
 * @param agoMs - How long before `LOGIN_TIME` the clock should read.
 * @returns A clock set that many milliseconds after the login.
 */
function buildClock(agoMs: number): ManualClock {
  const clock: ManualClock = {
    current: new Date(LOGIN_TIME.getTime() + agoMs),
    now: () => clock.current,
  };
  return clock;
}

interface TestApp {
  readonly app: Express;
  readonly logger: Logger;
  readonly info: MockInstance<Logger['info']>;
  readonly warn: MockInstance<Logger['warn']>;
  readonly error: MockInstance<Logger['error']>;
}

interface BuildAppOptions {
  readonly principal?: AuthenticatedPrincipal | undefined;
  readonly clock?: ManualClock;
  readonly recentLoginMaxAgeMs?: number;
}

/**
 * @param options - The caller the fake authentication middleware stores (none = anonymous), the
 * clock and an optional login age limit.
 * @returns An app whose routes are guarded in the ways the tests need, behind the shared error
 * handler, and spies on the logger.
 */
function buildApp(options: BuildAppOptions = {}): TestApp {
  const logger = createLogger({ serviceName: 'test', level: 'silent', nodeEnvironment: 'test' });
  const info = vi.spyOn(logger, 'info');
  const warn = vi.spyOn(logger, 'warn');
  const error = vi.spyOn(logger, 'error');
  const clock = options.clock ?? buildClock(0);
  const createGuard = createAccessGuard({
    logger,
    now: clock.now,
    ...(options.recentLoginMaxAgeMs === undefined
      ? {}
      : { recentLoginMaxAgeMs: options.recentLoginMaxAgeMs }),
  });
  const authenticateStub = (_request: Request, response: Response, next: NextFunction): void => {
    if (options.principal !== undefined) {
      setAuthenticatedPrincipal(response, options.principal);
    }
    next();
  };
  const echoScope = (_request: Request, response: Response): void => {
    response.json(getAccessScope(response));
  };

  const app = express();
  // Exists only for CodeQL's missing-rate-limiting query; its limit can never fire in a test.
  app.use(
    rateLimit({
      windowMs: TEST_RATE_LIMIT_WINDOW_MS,
      limit: TEST_RATE_LIMIT_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  const router = express.Router();
  router.get(
    '/things/:thingId',
    authenticateStub,
    createGuard({ permissions: ['inventory:create'] }),
    echoScope,
  );
  router.get(
    '/users',
    authenticateStub,
    createGuard({ permissions: ['user:read:any', 'user:read:tenant'] }),
    echoScope,
  );
  router.get(
    '/tenant-users',
    authenticateStub,
    createGuard({ permissions: ['user:read:tenant'] }),
    echoScope,
  );
  router.get('/roles', authenticateStub, createGuard({ permissions: ['role:manage'] }), echoScope);
  router.get(
    '/policies',
    authenticateStub,
    createGuard({ permissions: ['policy:manage'], recentLogin: true }),
    echoScope,
  );
  router.get('/no-authenticate', createGuard({ permissions: ['inventory:create'] }), echoScope);
  router.get('/no-guard', authenticateStub, echoScope);
  app.use('/v1', router);
  app.use(handleUnmatchedRoute);
  app.use(
    createErrorHandler({
      logger,
      getCorrelationId: () => 'test-correlation-id',
      isDebugInfoExposed: false,
    }),
  );
  return { app, logger, info, warn, error };
}

/**
 * @param testApp - The app under test.
 * @returns The `access refused` log entries written so far: [fields, message] pairs.
 */
function readRefusalLogs(testApp: TestApp): unknown[] {
  return testApp.info.mock.calls.filter(([, message]) => message === REFUSAL_LOG_MESSAGE);
}

/**
 * @param permissions - What the caller's token holds.
 * @param overrides - Other principal fields.
 * @returns A signed-in caller whose last login is `LOGIN_TIME`.
 */
function buildCaller(
  permissions: readonly string[],
  overrides: Partial<AuthenticatedPrincipal> = {},
): AuthenticatedPrincipal {
  return buildPrincipal({ permissions, authTime: LOGIN_TIME, ...overrides });
}

describe('createAccessGuard', () => {
  describe('a caller who holds a key', () => {
    it('reaches the handler with all scope when the token has no tenantId', async () => {
      const { app } = buildApp({ principal: buildCaller(['inventory:create']) });

      const response = await request(app).get('/v1/things/1');

      expect(response.status).toBe(OK);
      expect(response.body).toEqual({ kind: 'all' });
    });

    it('reaches the handler with tenant scope when the token has a tenantId', async () => {
      const principal = buildCaller(['inventory:create'], { tenantId: TENANT_ID });
      const { app } = buildApp({ principal });

      const response = await request(app).get('/v1/things/1');

      expect(response.status).toBe(OK);
      expect(response.body).toEqual({ kind: 'tenant', tenantId: TENANT_ID });
    });

    it('gives a tenant token tenant scope even when its role holds an :any key', async () => {
      const principal = buildCaller(['user:read:any'], { tenantId: TENANT_ID });
      const { app } = buildApp({ principal });

      const response = await request(app).get('/v1/users');

      expect(response.status).toBe(OK);
      expect(response.body).toEqual({ kind: 'tenant', tenantId: TENANT_ID });
    });

    it.each(['user:read:any', 'user:read:tenant'])(
      'is let in by %s on an any-of route',
      async (key) => {
        const { app } = buildApp({ principal: buildCaller([key], { tenantId: TENANT_ID }) });

        const response = await request(app).get('/v1/users');

        expect(response.status).toBe(OK);
      },
    );

    it('writes no refusal log line', async () => {
      const testApp = buildApp({ principal: buildCaller(['inventory:create']) });

      await request(testApp.app).get('/v1/things/1');

      expect(readRefusalLogs(testApp)).toEqual([]);
    });
  });

  describe('a caller without a usable key', () => {
    it('is answered with a generic 403 that names the required keys', async () => {
      const { app } = buildApp({ principal: buildCaller(['inventory:read']) });

      const response = await request(app).get('/v1/things/1');

      expect(response.status).toBe(FORBIDDEN);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).toMatchObject({
        status: FORBIDDEN,
        code: 'FORBIDDEN',
        detail: 'Missing permission `inventory:create`.',
      });
    });

    it('names every key of an any-of route', async () => {
      const { app } = buildApp({ principal: buildCaller([]) });

      const response = await request(app).get('/v1/users');

      expect(response.status).toBe(FORBIDDEN);
      expect(response.body).toMatchObject({
        detail: 'Missing one of the permissions `user:read:any`, `user:read:tenant`.',
      });
    });

    it('answers a :tenant key without a tenantId with the same 403 as a missing key', async () => {
      const missing = await request(buildApp({ principal: buildCaller([]) }).app).get(
        '/v1/tenant-users',
      );
      const noTenant = await request(
        buildApp({ principal: buildCaller(['user:read:tenant']) }).app,
      ).get('/v1/tenant-users');

      expect(noTenant.status).toBe(FORBIDDEN);
      expect(noTenant.body).toEqual(missing.body);
    });

    it('refuses a platform-only key to a token with a tenantId, with the same 403', async () => {
      const tenantCaller = buildCaller(['role:manage'], { tenantId: TENANT_ID });
      const missing = await request(buildApp({ principal: buildCaller([]) }).app).get('/v1/roles');
      const refused = await request(buildApp({ principal: tenantCaller }).app).get('/v1/roles');

      expect(refused.status).toBe(FORBIDDEN);
      expect(refused.body).toEqual(missing.body);
    });

    it('lets a platform-only key through for a token without a tenantId', async () => {
      const { app } = buildApp({ principal: buildCaller(['role:manage']) });

      const response = await request(app).get('/v1/roles');

      expect(response.status).toBe(OK);
      expect(response.body).toEqual({ kind: 'all' });
    });
  });

  describe('the refusal log', () => {
    it.each([
      ['inventory:read', {}, 'missing_permission', '/v1/things/:thingId', '/v1/things/1'],
      ['user:read:tenant', {}, 'tenant_key_without_tenant', '/v1/tenant-users', '/v1/tenant-users'],
      [
        'role:manage',
        { tenantId: TENANT_ID },
        'platform_only_with_tenant',
        '/v1/roles',
        '/v1/roles',
      ],
    ])(
      'records %s once, with ids, the reason, the keys and the route pattern',
      async (held, overrides, reason, pattern, url) => {
        const principal = buildCaller([held], overrides);
        const testApp = buildApp({ principal });

        await request(testApp.app).get(url);

        const required = pattern === '/v1/things/:thingId' ? ['inventory:create'] : [held];
        expect(readRefusalLogs(testApp)).toEqual([
          [
            {
              reason,
              userId: principal.userId,
              tokenId: principal.tokenId,
              requiredPermissions: required,
              method: 'GET',
              route: pattern,
            },
            REFUSAL_LOG_MESSAGE,
          ],
        ]);
      },
    );

    it('never contains a permission the caller holds, its role, or the raw URL', async () => {
      const principal = buildCaller(['inventory:read', 'user:read:tenant'], {
        roleKey: 'FESTIVAL_STAFF',
      });
      const testApp = buildApp({ principal });

      await request(testApp.app).get('/v1/things/123');

      const everyLogCall = [
        ...testApp.info.mock.calls,
        ...testApp.warn.mock.calls,
        ...testApp.error.mock.calls,
      ];
      const text = JSON.stringify(everyLogCall);
      expect(readRefusalLogs(testApp)).toHaveLength(1);
      expect(text).not.toContain('inventory:read');
      expect(text).not.toContain('user:read:tenant');
      expect(text).not.toContain('FESTIVAL_STAFF');
      expect(text).not.toContain('/v1/things/123');
    });
  });

  describe('recent login', () => {
    const HELD = ['policy:manage'];

    it.each([
      ['4:59', 4 * MINUTE_MS + 59 * SECOND_MS, OK],
      ['5:00', 5 * MINUTE_MS, OK],
      ['5:01', 5 * MINUTE_MS + SECOND_MS, UNAUTHORIZED],
    ])('with a login %s old answers %i', async (_label, ageMs, status) => {
      const { app } = buildApp({ principal: buildCaller(HELD), clock: buildClock(ageMs) });

      const response = await request(app).get('/v1/policies');

      expect(response.status).toBe(status);
    });

    it('is refused one millisecond past the limit', async () => {
      const clock = buildClock(5 * MINUTE_MS + 1);
      const { app } = buildApp({ principal: buildCaller(HELD), clock });

      expect((await request(app).get('/v1/policies')).status).toBe(UNAUTHORIZED);
    });

    it('answers the reauthentication problem with a Bearer challenge', async () => {
      const clock = buildClock(5 * MINUTE_MS + SECOND_MS);
      const { app } = buildApp({ principal: buildCaller(HELD), clock });

      const response = await request(app).get('/v1/policies');

      expect(response.status).toBe(UNAUTHORIZED);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).toMatchObject({
        type: 'https://api.ticketnest.example/problems/reauthentication-required',
        title: 'Recent login required',
        code: 'REAUTHENTICATION_REQUIRED',
        detail: 'This action needs a login within the last 5 minutes.',
      });
    });

    it('does not check the login of a route that does not ask for it', async () => {
      const clock = buildClock(24 * 60 * MINUTE_MS);
      const { app } = buildApp({ principal: buildCaller(['inventory:create']), clock });

      expect((await request(app).get('/v1/things/1')).status).toBe(OK);
    });

    it('uses the limit the guard was built with', async () => {
      const clock = buildClock(2 * MINUTE_MS);
      const { app } = buildApp({
        principal: buildCaller(HELD),
        clock,
        recentLoginMaxAgeMs: MINUTE_MS,
      });

      expect((await request(app).get('/v1/policies')).status).toBe(UNAUTHORIZED);
    });

    it('is logged once, with the reason', async () => {
      const principal = buildCaller(HELD);
      const testApp = buildApp({ principal, clock: buildClock(6 * MINUTE_MS) });

      await request(testApp.app).get('/v1/policies');

      expect(readRefusalLogs(testApp)).toEqual([
        [
          {
            reason: 'recent_login_required',
            userId: principal.userId,
            tokenId: principal.tokenId,
            requiredPermissions: ['policy:manage'],
            method: 'GET',
            route: '/v1/policies',
          },
          REFUSAL_LOG_MESSAGE,
        ],
      ]);
    });
  });

  describe('order of checks', () => {
    it('answers 403, not a request to sign in again, when the permission is missing too', async () => {
      const clock = buildClock(60 * MINUTE_MS);
      const { app } = buildApp({ principal: buildCaller(['inventory:read']), clock });

      const response = await request(app).get('/v1/policies');

      expect(response.status).toBe(FORBIDDEN);
      expect(response.body).not.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    });
  });

  describe('a caller who is not authenticated', () => {
    it('gets the invalid-token 401 when the authentication middleware found no caller', async () => {
      const { app } = buildApp();

      const response = await request(app).get('/v1/things/1');

      expect(response.status).toBe(UNAUTHORIZED);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.body).toMatchObject({
        title: 'Authentication required',
        code: 'UNAUTHENTICATED',
        detail: 'Missing, expired, or invalid access token.',
      });
    });

    it('gets the same 401 when no authentication middleware is mounted at all', async () => {
      const wired = await request(buildApp().app).get('/v1/things/1');
      const unmounted = await request(
        buildApp({ principal: buildCaller(['inventory:create']) }).app,
      ).get('/v1/no-authenticate');

      expect(unmounted.status).toBe(UNAUTHORIZED);
      expect(unmounted.body).toEqual({ ...wired.body, instance: '/v1/no-authenticate' });
    });

    it('is logged without ids', async () => {
      const testApp = buildApp();

      await request(testApp.app).get('/v1/things/1');

      expect(readRefusalLogs(testApp)).toEqual([
        [
          {
            reason: 'no_principal',
            requiredPermissions: ['inventory:create'],
            method: 'GET',
            route: '/v1/things/:thingId',
          },
          REFUSAL_LOG_MESSAGE,
        ],
      ]);
    });
  });

  describe('getAccessScope', () => {
    it('answers 500 for a handler no guard protects, never an unrestricted scope', async () => {
      const { app } = buildApp({ principal: buildCaller(['inventory:create']) });

      const response = await request(app).get('/v1/no-guard');

      expect(response.status).toBe(INTERNAL_SERVER_ERROR);
      expect(response.body).not.toHaveProperty('kind');
      expect(response.body).not.toHaveProperty('detail');
    });
  });

  describe('building a route', () => {
    it('throws when a key is not in the catalogue', () => {
      const logger = createLogger({
        serviceName: 'test',
        level: 'silent',
        nodeEnvironment: 'test',
      });
      const createGuard = createAccessGuard({ logger });
      const typo = 'inventory:creat' as unknown as PermissionKey;

      expect(() => createGuard({ permissions: [typo] })).toThrow(InvalidGuardConfigurationError);
      expect(() => createGuard({ permissions: [typo] })).toThrow('inventory:creat');
    });
  });
});
