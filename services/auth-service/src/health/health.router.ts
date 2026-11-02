import { type Logger } from '@ticketnest/logger';
import { Router } from 'express';

import { type DependencyCheck, runDependencyChecks } from './dependency-check';

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

export interface HealthRouterDependencies {
  readonly logger: Logger;
  readonly readinessChecks: readonly DependencyCheck[];
  readonly isShuttingDown: () => boolean;
  readonly checkTimeoutMs?: number;
}

/**
 * `/health/live`: the process is up, no dependency is touched (restart me if this fails).
 * `/health/ready`: dependencies answer and the service is not draining (send me traffic).
 */
export function createHealthRouter(dependencies: HealthRouterDependencies): Router {
  const {
    logger,
    readinessChecks,
    isShuttingDown,
    checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
  } = dependencies;
  const router = Router();

  router.use('/health', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/health/live', (_request, response) => {
    response.json({ status: 'ok' });
  });

  router.get('/health/ready', async (_request, response) => {
    if (isShuttingDown()) {
      response.status(HTTP_SERVICE_UNAVAILABLE).json({ status: 'shutting_down', checks: {} });
      return;
    }
    const report = await runDependencyChecks(readinessChecks, {
      timeoutMs: checkTimeoutMs,
      logger,
    });
    response
      .status(report.isReady ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE)
      .json({ status: report.isReady ? 'ok' : 'unavailable', checks: report.checks });
  });

  return router;
}
