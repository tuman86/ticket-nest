import { loadConfig } from '@ticketnest/config';
import { createLogger, type Logger } from '@ticketnest/logger';
import { createPostgresCheck, createShutdown } from '@ticketnest/service-runtime';
import { Pool } from 'pg';

import { createApp } from './app';
import { type CatalogConfig, catalogConfigSchema, SERVICE_NAME } from './config';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const CONNECT_TIMEOUT_MS = 2_000;

/**
 * Creates the Postgres pool with an error listener, since an error on an idle pooled client would
 * otherwise crash the process.
 *
 * @param config - The validated configuration.
 * @param logger - Receives pool errors.
 * @returns A pool that connects on first use.
 */
function createPool(config: CatalogConfig, logger: Logger): Pool {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  pool.on('error', (error) => {
    logger.error({ err: error }, 'postgres pool error');
  });
  return pool;
}

/** Composition root: the only place that names concrete clients. */
function main(): void {
  const config = loadConfig(catalogConfigSchema);
  const logger = createLogger({
    serviceName: SERVICE_NAME,
    level: config.LOG_LEVEL,
    nodeEnvironment: config.NODE_ENV,
  });
  const pool = createPool(config, logger);

  const { isShuttingDown, shutdown } = createShutdown({
    resources: [{ name: 'postgres', close: () => pool.end() }],
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    logger,
    exit: (code) => process.exit(code),
  });

  const app = createApp({
    logger,
    readinessChecks: [createPostgresCheck(pool)],
    isShuttingDown,
    jsonBodyLimit: config.JSON_BODY_LIMIT,
    isDebugInfoExposed: config.NODE_ENV === 'development',
    trustProxyHops: config.TRUST_PROXY_HOPS,
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
