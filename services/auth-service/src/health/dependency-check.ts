import { type Logger } from '@ticketnest/logger';

/** Something the service needs in order to serve traffic, e.g. its database. */
export interface DependencyCheck {
  readonly name: string;
  /** Resolves when the dependency is reachable and rejects when it is not. */
  check: () => Promise<void>;
}

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  readonly isReady: boolean;
  readonly checks: Readonly<Record<string, DependencyStatus>>;
}

export interface RunDependencyChecksOptions {
  readonly timeoutMs: number;
  readonly logger: Logger;
}

function rejectAfter(timeoutMs: number): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

async function checkWithTimeout(
  dependency: DependencyCheck,
  options: RunDependencyChecksOptions,
): Promise<DependencyStatus> {
  const timeout = rejectAfter(options.timeoutMs);
  try {
    await Promise.race([dependency.check(), timeout.promise]);
    return 'up';
  } catch (error) {
    // The real reason is logged here. It never reaches the response body.
    options.logger.warn({ err: error, dependency: dependency.name }, 'dependency check failed');
    return 'down';
  } finally {
    timeout.cancel();
  }
}

/** Runs every check in parallel. A hung dependency counts as down after `timeoutMs`. */
export async function runDependencyChecks(
  dependencies: readonly DependencyCheck[],
  options: RunDependencyChecksOptions,
): Promise<ReadinessReport> {
  const statuses = await Promise.all(
    dependencies.map((dependency) => checkWithTimeout(dependency, options)),
  );
  const checks = Object.fromEntries(
    dependencies.map((dependency, index) => [dependency.name, statuses[index] ?? 'down']),
  );
  return { isReady: statuses.every((status) => status === 'up'), checks };
}
