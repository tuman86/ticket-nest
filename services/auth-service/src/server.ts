import { loadConfig } from '@ticketnest/config';
import { createLogger, type Logger } from '@ticketnest/logger';
import { closeRedisClient, RedisFixedWindowRateLimiter } from '@ticketnest/rate-limit';
import { createShutdown } from '@ticketnest/service-runtime';
import { type Router } from 'express';
import { Redis } from 'ioredis';
import { Pool } from 'pg';

import { createApp } from './app';
import { createLocalAccessTokenVerifier } from './auth/create-local-access-token-verifier';
import { EdDsaTokenService } from './auth/eddsa-token-service';
import { JwksService } from './auth/jwks.service';
import { createSigningKeySet } from './auth/signing-key-set';
import { composeAuthRouter } from './compose-auth-router';
import { type AuthConfig, authConfigSchema, SERVICE_NAME } from './config';
import { createPostgresCheck } from './health/postgres-check';
import { createRedisCheck } from './health/redis-check';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const CONNECT_TIMEOUT_MS = 2_000;

/**
 * Builds the signing key set before any connection opens, so a bad key stops startup without
 * touching Postgres or Redis.
 *
 * @param config - The validated configuration.
 * @param logger - Receives the ids (never the keys) of the loaded keys.
 * @returns The key set that signs tokens and publishes the public keys.
 */
async function loadSigningKeys(config: AuthConfig, logger: Logger) {
  const keySet = await createSigningKeySet({
    privateKey: config.JWT_PRIVATE_KEY,
    additionalPublicKeys: config.JWT_ADDITIONAL_PUBLIC_KEYS,
  });
  logger.info(
    {
      signingKeyId: keySet.signingKeyId,
      publishedKeyIds: keySet.publicJwks.map((jwk) => jwk.kid),
    },
    'signing keys loaded',
  );
  return keySet;
}

/**
 * Creates the Postgres pool with an error listener, since an error on an idle pooled client would
 * otherwise crash the process.
 *
 * @param config - The validated configuration.
 * @param logger - Receives pool errors.
 * @returns A pool that connects on first use.
 */
function createPool(config: AuthConfig, logger: Logger): Pool {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  pool.on('error', (error) => {
    logger.error({ err: error }, 'postgres pool error');
  });
  return pool;
}

/**
 * Creates the Redis client the rate limiter and the readiness check use. It never queues commands
 * while disconnected, so an outage fails fast.
 *
 * @param config - The validated configuration.
 * @param logger - Receives connection errors.
 * @returns A Redis client that is connecting in the background.
 */
function createRedisClient(config: AuthConfig, logger: Logger): Redis {
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
 * Builds the routers of the service from its keys and clients.
 *
 * @param dependencies - The configuration, logger, key set and clients built by `main`.
 * @returns The routers to mount after the health endpoints.
 */
async function composeRouters(dependencies: {
  readonly config: AuthConfig;
  readonly logger: Logger;
  readonly keySet: Awaited<ReturnType<typeof loadSigningKeys>>;
  readonly pool: Pool;
  readonly redis: Redis;
}): Promise<readonly Router[]> {
  const { config, logger, keySet, pool, redis } = dependencies;
  return composeAuthRouter({
    pool,
    logger,
    tokenService: new EdDsaTokenService({
      privateKey: keySet.signingPrivateKey,
      keyId: keySet.signingKeyId,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }),
    // auth-service holds its own keys, so it verifies its tokens from memory instead of calling its
    // own JWKS endpoint. Every other service builds a `JwksKeyResolver` here instead.
    accessTokenVerifier: createLocalAccessTokenVerifier({
      verificationKeys: keySet.verificationKeys,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }),
    jwksService: new JwksService(keySet.publicJwks),
    refreshReuseGraceMs: config.REFRESH_REUSE_GRACE_MS,
    rateLimiter: new RedisFixedWindowRateLimiter(redis),
    rateLimitKeyPepper: config.RATE_LIMIT_KEY_PEPPER,
  });
}

/** Composition root: the only place that names concrete clients. */
async function main(): Promise<void> {
  const config = loadConfig(authConfigSchema);
  const logger = createLogger({
    serviceName: SERVICE_NAME,
    level: config.LOG_LEVEL,
    nodeEnvironment: config.NODE_ENV,
  });
  const keySet = await loadSigningKeys(config, logger);
  const pool = createPool(config, logger);
  const redis = createRedisClient(config, logger);

  const { isShuttingDown, shutdown } = createShutdown({
    resources: [
      { name: 'postgres', close: () => pool.end() },
      { name: 'redis', close: () => closeRedisClient(redis) },
    ],
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    logger,
    exit: (code) => process.exit(code),
  });

  const app = createApp({
    logger,
    readinessChecks: [createPostgresCheck(pool), createRedisCheck(redis)],
    isShuttingDown,
    corsOrigins: config.CORS_ORIGINS,
    jsonBodyLimit: config.JSON_BODY_LIMIT,
    isDebugInfoExposed: config.NODE_ENV === 'development',
    trustProxyHops: config.TRUST_PROXY_HOPS,
    routers: await composeRouters({ config, logger, keySet, pool, redis }),
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

main().catch((error: unknown) => {
  // The logger may not exist yet (bad config), so write plainly. Config errors list names, never values.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
