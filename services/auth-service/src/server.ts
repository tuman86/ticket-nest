import { createPublicKey } from 'node:crypto';

import { loadConfig } from '@ticketnest/config';
import { createLogger } from '@ticketnest/logger';
import { Redis } from 'ioredis';
import { Pool } from 'pg';

import { createApp } from './app';
import { EdDsaAccessTokenVerifier } from './auth/eddsa-access-token-verifier';
import { EdDsaTokenService } from './auth/eddsa-token-service';
import { composeAuthRouter } from './compose-auth-router';
import { authConfigSchema, SERVICE_NAME } from './config';
import { createPostgresCheck } from './health/postgres-check';
import { createRedisCheck } from './health/redis-check';
import { createShutdown } from './shutdown';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const CONNECT_TIMEOUT_MS = 2_000;

/** Composition root: the only place that names concrete clients. */
async function main(): Promise<void> {
  const config = loadConfig(authConfigSchema);
  const logger = createLogger({
    serviceName: SERVICE_NAME,
    level: config.LOG_LEVEL,
    nodeEnvironment: config.NODE_ENV,
  });

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // Without a listener, an error on an idle pooled client would crash the process.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'postgres pool error');
  });

  const redis = new Redis(config.REDIS_URL, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableOfflineQueue: false,
  });
  redis.on('error', (error: Error) => {
    logger.error({ err: error }, 'redis error');
  });

  const { isShuttingDown, shutdown } = createShutdown({
    resources: [
      { name: 'postgres', close: () => pool.end() },
      {
        name: 'redis',
        close: async () => {
          await redis.quit();
        },
      },
    ],
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    logger,
    exit: (code) => process.exit(code),
  });

  const tokenService = new EdDsaTokenService({
    privateKey: config.JWT_PRIVATE_KEY,
    keyId: config.JWT_KEY_ID,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });

  const accessTokenVerifier = new EdDsaAccessTokenVerifier({
    publicKey: createPublicKey(config.JWT_PRIVATE_KEY),
    keyId: config.JWT_KEY_ID,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });

  const app = createApp({
    logger,
    readinessChecks: [createPostgresCheck(pool), createRedisCheck(redis)],
    isShuttingDown,
    corsOrigins: config.CORS_ORIGINS,
    jsonBodyLimit: config.JSON_BODY_LIMIT,
    isDebugInfoExposed: config.NODE_ENV === 'development',
    routers: await composeAuthRouter({
      pool,
      logger,
      tokenService,
      accessTokenVerifier,
      refreshReuseGraceMs: config.REFRESH_REUSE_GRACE_MS,
    }),
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
