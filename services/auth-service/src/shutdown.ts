import { type Logger } from '@ticketnest/logger';

const EXIT_OK = 0;
const EXIT_FAILED = 1;

/** The slice of `http.Server` that shutdown needs. */
export interface ClosableServer {
  close: (callback: (error?: Error) => void) => unknown;
  closeIdleConnections: () => void;
  closeAllConnections: () => void;
}

/** A connection to release once no request needs it any more, e.g. a database pool. */
export interface ShutdownResource {
  readonly name: string;
  close: () => Promise<void>;
}

export interface ShutdownOptions {
  /** Closed one after another, in this order, after the server has drained. */
  readonly resources: readonly ShutdownResource[];
  readonly timeoutMs: number;
  readonly logger: Logger;
  readonly exit: (code: number) => void;
}

export interface Shutdown {
  isShuttingDown: () => boolean;
  /** Safe to call more than once: later calls wait for the first shutdown. */
  shutdown: (signal: string, server: ClosableServer) => Promise<void>;
}

function stopAcceptingRequests(server: ClosableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
    server.closeIdleConnections();
  });
}

async function closeResources(
  resources: readonly ShutdownResource[],
  logger: Logger,
): Promise<boolean> {
  let isClean = true;
  for (const resource of resources) {
    try {
      await resource.close();
    } catch (error) {
      isClean = false;
      logger.error({ err: error, resource: resource.name }, 'failed to close resource');
    }
  }
  return isClean;
}

async function drain(options: ShutdownOptions, server: ClosableServer): Promise<boolean> {
  try {
    await stopAcceptingRequests(server);
  } catch (error) {
    options.logger.error({ err: error }, 'failed to stop the server');
    return false;
  }
  return closeResources(options.resources, options.logger);
}

/**
 * Stops accepting requests, lets in-flight ones finish, then closes the resources.
 * If that takes longer than `timeoutMs`, remaining connections are cut and the exit code is 1.
 */
export function createShutdown(options: ShutdownOptions): Shutdown {
  const { timeoutMs, logger, exit } = options;
  let running: Promise<void> | undefined;

  async function run(signal: string, server: ClosableServer): Promise<void> {
    logger.info({ signal }, 'shutdown started');
    const forceTimer = setTimeout(() => {
      logger.error({ timeoutMs }, 'shutdown timed out, closing remaining connections');
      server.closeAllConnections();
      exit(EXIT_FAILED);
    }, timeoutMs);

    const isClean = await drain(options, server);
    clearTimeout(forceTimer);
    logger.info({ isClean }, 'shutdown finished');
    exit(isClean ? EXIT_OK : EXIT_FAILED);
  }

  return {
    isShuttingDown: () => running !== undefined,
    shutdown: (signal, server) => {
      running ??= run(signal, server);
      return running;
    },
  };
}
