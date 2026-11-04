import { loadConfig } from '@ticketnest/config';
import { createLogger, type Logger } from '@ticketnest/logger';
import {
  closeRedisClient,
  RateLimitService,
  RedisFixedWindowRateLimiter,
} from '@ticketnest/rate-limit';
import { type Router } from 'express';
import { createShutdown } from '@ticketnest/service-runtime';
import { Redis } from 'ioredis';

import { createApp } from './app';
import { createAuthenticateByMode } from './auth/authenticate-by-mode.middleware';
import { createJwksAccessTokenVerifier } from './auth/create-jwks-access-token-verifier';
import { type GatewayConfig, gatewayConfigSchema, SERVICE_NAME } from './config';
import { CircuitBreaker } from './proxy/circuit-breaker';
import { createForwardController } from './proxy/forward.controller';
import { ForwardService } from './proxy/forward.service';
import { CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_OPEN_MS } from './proxy/proxy-constants';
import { createProxyRouter } from './proxy/proxy.router';
import { UndiciUpstreamClient } from './proxy/undici-upstream-client';
import { createGatewayRateLimiters } from './rate-limit/create-gateway-rate-limiters';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const CONNECT_TIMEOUT_MS = 2_000;
const JWKS_PATH = '/.well-known/jwks.json';

/**
 * Connects the Redis client the rate limiter uses. It never queues commands while disconnected,
 * so a Redis outage fails the limiter at once (and the limiter fails open) instead of hanging.
 *
 * @param config - The validated configuration.
 * @param logger - Receives connection errors.
 * @returns A Redis client that is connecting in the background.
 */
function createRedisClient(config: GatewayConfig, logger: Logger): Redis {
  const redis = new Redis(config.REDIS_URL, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableOfflineQueue: false,
  });
  redis.on('error', (error: Error) => {
    logger.error({ err: error }, 'redis error');
  });
  return redis;
}

/**
 * Wires the proxy pipeline: the limits, the token check, the forwarding and their dependencies.
 *
 * @param dependencies - The configuration, the logger and the clients built by `main`.
 * @returns The router that serves every proxied route.
 */
function composeProxyRouter(dependencies: {
  readonly config: GatewayConfig;
  readonly logger: Logger;
  readonly redis: Redis;
  readonly upstreamClient: UndiciUpstreamClient;
}): Router {
  const { config, logger, redis, upstreamClient } = dependencies;
  const rateLimiters = createGatewayRateLimiters({
    rateLimitService: new RateLimitService({
      rateLimiter: new RedisFixedWindowRateLimiter(redis),
      logger,
    }),
  });
  /**
   * @returns A fresh breaker, so each service fails on its own.
   */
  const createBreaker = (): CircuitBreaker =>
    new CircuitBreaker({ failureThreshold: CIRCUIT_FAILURE_THRESHOLD, openMs: CIRCUIT_OPEN_MS });
  return createProxyRouter({
    limitByIp: rateLimiters.byIp,
    authenticate: createAuthenticateByMode({
      verifier: createJwksAccessTokenVerifier({
        jwksUrl: `${config.AUTH_SERVICE_URL}${JWKS_PATH}`,
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        logger,
      }),
      logger,
    }),
    limitByUser: rateLimiters.byUser,
    forward: createForwardController({
      forwardService: new ForwardService({
        upstreamClient,
        circuitBreakers: { auth: createBreaker(), catalog: createBreaker() },
        maxRequestBodyBytes: config.MAX_REQUEST_BODY_BYTES,
        logger,
      }),
    }),
    maxRequestBodyBytes: config.MAX_REQUEST_BODY_BYTES,
  });
}

/** Composition root: the only place that names concrete clients. */
function main(): void {
  const config = loadConfig(gatewayConfigSchema);
  const logger = createLogger({
    serviceName: SERVICE_NAME,
    level: config.LOG_LEVEL,
    nodeEnvironment: config.NODE_ENV,
  });
  const redis = createRedisClient(config, logger);
  const upstreamClient = new UndiciUpstreamClient({
    origins: { auth: config.AUTH_SERVICE_URL, catalog: config.CATALOG_SERVICE_URL },
  });

  const { isShuttingDown, shutdown } = createShutdown({
    resources: [
      { name: 'upstreams', close: () => upstreamClient.close() },
      { name: 'redis', close: () => closeRedisClient(redis) },
    ],
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    logger,
    exit: (code) => process.exit(code),
  });

  const app = createApp({
    logger,
    // The gateway keeps no data, and Redis only backs the rate limiter, which fails open. Reporting
    // Redis here would pull every replica out of rotation during a Redis outage, which is the
    // opposite of failing open. The services and JWKS are not checked either: stale keys keep
    // working for up to an hour, and one failing service must not make the others unreachable.
    readinessChecks: [],
    isShuttingDown,
    corsOrigins: config.CORS_ORIGINS,
    isDebugInfoExposed: config.NODE_ENV === 'development',
    trustProxyHops: config.TRUST_PROXY_HOPS,
    routers: [composeProxyRouter({ config, logger, redis, upstreamClient })],
  });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'server listening');
  });
  server.once('error', (error) => {
    logger.fatal({ err: error }, 'server failed to start');
    process.exit(1);
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => void shutdown(signal, server));
  }
}

try {
  main();
} catch (error: unknown) {
  // The logger may not exist yet (bad config), so write plainly. Config errors list names, never values.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
