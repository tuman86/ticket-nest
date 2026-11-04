import { JwtAccessTokenVerifier, StaticKeyResolver } from '@ticketnest/auth-middleware';
import { createLogger, type Logger } from '@ticketnest/logger';
import { RateLimitService, type RateLimitPolicy } from '@ticketnest/rate-limit';
import { InMemoryRateLimiter } from '@ticketnest/rate-limit/testing';
import { type Express } from 'express';

import { createApp, type AppDependencies } from '@/app';
import { createAuthenticateByMode } from '@/auth/authenticate-by-mode.middleware';
import { CircuitBreaker } from '@/proxy/circuit-breaker';
import { createForwardController } from '@/proxy/forward.controller';
import { ForwardService } from '@/proxy/forward.service';
import { createProxyRouter } from '@/proxy/proxy.router';
import { type UpstreamClient } from '@/proxy/upstream-client';
import { createGatewayRateLimiters } from '@/rate-limit/create-gateway-rate-limiters';

import { FakeUpstreamClient } from './fake-upstream-client';
import { getTestPublicKey, TEST_AUDIENCE, TEST_ISSUER, TEST_KEY_ID } from './test-signing-keys';

export type LogLine = Record<string, unknown>;

export interface TestApp {
  readonly app: Express;
  readonly logger: Logger;
  readonly lines: LogLine[];
  /** The default fake service. Present even when `upstreamClient` is replaced. */
  readonly upstream: FakeUpstreamClient;
  readonly limiter: InMemoryRateLimiter;
}

export interface CreateTestAppOptions {
  /** Replaces the fake service, for example with the real undici client. */
  readonly upstreamClient?: UpstreamClient;
  readonly ipPolicy?: RateLimitPolicy;
  readonly userPolicy?: RateLimitPolicy;
  readonly maxRequestBodyBytes?: number;
  readonly circuitFailureThreshold?: number;
  /** App dependencies to replace (CORS origins, trusted proxy hops...). */
  readonly appOverrides?: Partial<AppDependencies>;
}

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_024;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;
const TEST_CIRCUIT_OPEN_MS = 10_000;

/**
 * Builds the real gateway app with a fake service, an in-memory rate limiter, and the real token
 * verifier over a throwaway test key, plus a logger that collects its lines.
 *
 * @param options - Parts to replace.
 * @returns The app and the fakes to inspect.
 */
export function createTestApp(options: CreateTestAppOptions = {}): TestApp {
  const lines: LogLine[] = [];
  const logger = createLogger({
    serviceName: 'api-gateway',
    level: 'debug',
    nodeEnvironment: 'test',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
  });
  const upstream = new FakeUpstreamClient();
  const limiter = new InMemoryRateLimiter();
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const rateLimiters = createGatewayRateLimiters({
    rateLimitService: new RateLimitService({ rateLimiter: limiter, logger }),
    ...(options.ipPolicy === undefined ? {} : { ipPolicy: options.ipPolicy }),
    ...(options.userPolicy === undefined ? {} : { userPolicy: options.userPolicy }),
  });
  const createBreaker = () =>
    new CircuitBreaker({
      failureThreshold: options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
      openMs: TEST_CIRCUIT_OPEN_MS,
    });
  const verifier = new JwtAccessTokenVerifier({
    keyResolver: new StaticKeyResolver(new Map([[TEST_KEY_ID, getTestPublicKey()]])),
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
  });
  const forwardService = new ForwardService({
    upstreamClient: options.upstreamClient ?? upstream,
    circuitBreakers: { auth: createBreaker(), catalog: createBreaker() },
    maxRequestBodyBytes,
    logger,
    sleep: () => Promise.resolve(),
  });
  const app = createApp({
    logger,
    readinessChecks: [],
    isShuttingDown: () => false,
    corsOrigins: [],
    isDebugInfoExposed: false,
    routers: [
      createProxyRouter({
        limitByIp: rateLimiters.byIp,
        authenticate: createAuthenticateByMode({ verifier, logger }),
        limitByUser: rateLimiters.byUser,
        forward: createForwardController({ forwardService }),
        maxRequestBodyBytes,
      }),
    ],
    ...options.appOverrides,
  });
  return { app, logger, lines, upstream, limiter };
}
