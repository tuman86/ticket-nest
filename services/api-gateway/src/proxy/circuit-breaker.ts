import { ServiceUnavailableError } from '@ticketnest/errors';

import { MILLISECONDS_PER_SECOND } from './proxy-constants';

const UPSTREAM_UNAVAILABLE_CODE = 'UPSTREAM_UNAVAILABLE';

/** `Retry-After` is never 0: a client told to retry at once would hit the open circuit again. */
const MINIMUM_RETRY_AFTER_SECONDS = 1;

export interface CircuitBreakerOptions {
  /** Failures in a row that open the circuit. */
  readonly failureThreshold: number;
  /** How long the circuit stays open before one trial request is let through. */
  readonly openMs: number;
  /** Clock in milliseconds, replaceable in tests. */
  readonly now?: () => number;
}

/**
 * Stops sending requests to a service that keeps failing, so the gateway answers fast instead of
 * piling up slow calls, and gives the service room to recover. After `failureThreshold` failures
 * in a row the circuit opens; after `openMs` exactly one trial request goes through, and its
 * outcome closes the circuit or opens it again. One breaker per service.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private isOpen = false;
  private isTrialRunning = false;
  private openedAtMs = 0;
  private readonly now: () => number;

  /**
   * @param options - The failure threshold, the open duration and an optional clock.
   */
  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Asks permission to send a request. Call `recordSuccess`, `recordFailure` or `recordNeutral`
   * afterwards, so a trial request always settles the circuit.
   *
   * @throws ServiceUnavailableError (with `Retry-After`) while the circuit is open, or while its
   *   single trial request is still running.
   */
  beforeRequest(): void {
    if (!this.isOpen) {
      return;
    }
    const remainingMs = this.options.openMs - (this.now() - this.openedAtMs);
    if (remainingMs > 0 || this.isTrialRunning) {
      throw this.createOpenError(Math.max(remainingMs, 0));
    }
    this.isTrialRunning = true;
  }

  /** Records that the service answered normally. Closes the circuit. */
  recordSuccess(): void {
    this.isOpen = false;
    this.isTrialRunning = false;
    this.consecutiveFailures = 0;
  }

  /** Records that the service looked down. Opens the circuit at the threshold, or at once when a trial request fails. */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.isTrialRunning || this.consecutiveFailures >= this.options.failureThreshold) {
      this.isOpen = true;
      this.openedAtMs = this.now();
    }
    this.isTrialRunning = false;
  }

  /**
   * Records that the request ended for a reason that says nothing about the service (the client
   * sent too large a body, or went away). A running trial is released so another can start.
   */
  recordNeutral(): void {
    this.isTrialRunning = false;
  }

  /**
   * @param remainingMs - How long until a trial request is allowed.
   * @returns The 503 to throw, telling the client when to retry.
   */
  private createOpenError(remainingMs: number): ServiceUnavailableError {
    return new ServiceUnavailableError({
      code: UPSTREAM_UNAVAILABLE_CODE,
      retryAfterSeconds: Math.max(
        MINIMUM_RETRY_AFTER_SECONDS,
        Math.ceil(remainingMs / MILLISECONDS_PER_SECOND),
      ),
    });
  }
}
