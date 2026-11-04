import { ServiceUnavailableError, TooManyRequestsError } from '@ticketnest/errors';
import { type Logger } from '@ticketnest/logger';

import {
  MILLISECONDS_PER_SECOND,
  MINIMUM_RETRY_AFTER_SECONDS,
  RATE_LIMIT_TIMEOUT_MS,
  RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from './rate-limit-constants';
import { buildRateLimitKey } from './rate-limit-key';
import {
  type RateLimitIdentifiers,
  type RateLimitPolicy,
  type RateLimitRule,
} from './rate-limit-policy';
import { type RateLimitDecision, type RateLimiter } from './rate-limiter';

export interface RateLimitServiceOptions {
  readonly rateLimiter: RateLimiter;
  /**
   * Secret mixed into the keys of hashed scopes (emails, refresh tokens). From
   * `RATE_LIMIT_KEY_PEPPER`. Optional for a service whose policies only use plaintext scopes.
   */
  readonly keyPepper?: string;
  readonly logger: Logger;
  /** How long one limiter call may take before it counts as down. Defaults to `RATE_LIMIT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** What one limiter call came to: a decision, or the news that the limiter could not decide. */
type ConsumeOutcome =
  | { readonly kind: 'decided'; readonly decision: RateLimitDecision }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'error' | 'timeout';
      readonly error?: unknown;
    };

/** A running timer that settles as `unavailable` when the limiter takes too long. */
interface Deadline {
  /** Resolves to a `timeout` outcome once the time is up. Never rejects. */
  readonly expired: Promise<ConsumeOutcome>;
  /** Stops the timer, so a call that finished in time leaves nothing pending. */
  readonly cancel: () => void;
}

/**
 * Wraps a limiter's answer so it can race against the deadline.
 *
 * @param decision - What the limiter answered.
 * @returns The decision, wrapped as an outcome.
 */
function toDecidedOutcome(decision: RateLimitDecision): ConsumeOutcome {
  return { kind: 'decided', decision };
}

/**
 * Turns a failed limiter call into data, so the caller applies the policy's failure mode.
 *
 * @param error - Why the limiter call failed.
 * @returns An `unavailable` outcome that keeps the cause.
 */
function toFailedOutcome(error: unknown): ConsumeOutcome {
  return { kind: 'unavailable', reason: 'error', error };
}

/**
 * Starts a timer for one limiter call.
 *
 * @param timeoutMs - How long the call may take, in milliseconds.
 * @returns The promise that fires at the deadline, and a way to cancel it.
 */
function startDeadline(timeoutMs: number): Deadline {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<ConsumeOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'unavailable', reason: 'timeout' });
    }, timeoutMs);
  });
  return {
    expired,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Applies a policy's rules to a request: counts it against each rule in order and refuses it at
 * the first rule that is over its limit. It also decides what happens when the limiter is down.
 */
export class RateLimitService {
  private readonly rateLimiter: RateLimiter;
  private readonly keyPepper: string | undefined;
  private readonly logger: Logger;
  private readonly timeoutMs: number;

  /**
   * Creates the service around a limiter.
   *
   * @param options - The limiter, the key pepper, the logger and an optional timeout.
   */
  constructor(options: RateLimitServiceOptions) {
    this.rateLimiter = options.rateLimiter;
    this.keyPepper = options.keyPepper;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? RATE_LIMIT_TIMEOUT_MS;
  }

  /**
   * Counts a request against every rule of a policy. A rule whose identifier the request does not
   * have (no usable email in the body, say) is skipped. Checking stops at the first denial, so a
   * blocked IP cannot use up a victim's email counter. Side effect: increments Redis counters.
   *
   * @param policy - The endpoint's rules and failure mode.
   * @param identifiers - What the request can be counted by.
   * @throws TooManyRequestsError when a rule is over its limit; carries `Retry-After`.
   * @throws ServiceUnavailableError when the limiter is down and the policy fails closed.
   */
  async check(policy: RateLimitPolicy, identifiers: RateLimitIdentifiers): Promise<void> {
    for (const rule of policy.rules) {
      const identifier = identifiers[rule.scope];
      if (identifier === undefined) {
        continue;
      }
      const key = buildRateLimitKey({
        policyName: policy.name,
        scope: rule.scope,
        identifier,
        pepper: this.keyPepper,
      });
      const outcome = await this.consume(key, rule);
      if (outcome.kind === 'unavailable') {
        this.handleUnavailable(policy, outcome);
        return;
      }
      if (!outcome.decision.isAllowed) {
        this.logger.warn({ policy: policy.name, scope: rule.scope }, 'rate limit exceeded');
        throw new TooManyRequestsError({
          limit: rule.limit,
          retryAfterSeconds: Math.max(
            MINIMUM_RETRY_AFTER_SECONDS,
            Math.ceil(outcome.decision.retryAfterMs / MILLISECONDS_PER_SECOND),
          ),
        });
      }
    }
  }

  /**
   * Calls the limiter with a deadline, so an error, a hang and a slow answer all come back as data.
   *
   * @param key - The counter to increment.
   * @param rule - The limit and window to apply.
   * @returns The decision, or `unavailable` when the call failed or took longer than the timeout.
   */
  private async consume(key: string, rule: RateLimitRule): Promise<ConsumeOutcome> {
    const deadline = startDeadline(this.timeoutMs);
    // The executor turns a synchronous throw from `consume` into a rejection too, so a limiter
    // that is not `async` still ends up in the failure mode instead of as a 500.
    const attempt = new Promise<RateLimitDecision>((resolve) => {
      resolve(this.rateLimiter.consume(key, rule.limit, rule.windowMs));
    }).then(toDecidedOutcome, toFailedOutcome);
    try {
      return await Promise.race([attempt, deadline.expired]);
    } finally {
      deadline.cancel();
    }
  }

  /**
   * Applies the policy's failure mode. Logs the policy and the reason only: never a key or an
   * identifier, which could hold an email. When the request is refused, the underlying failure
   * travels as the 503's `cause` and the shared error handler logs it, so the failure is logged
   * once at error level and not twice.
   *
   * @param policy - The policy whose limiter failed.
   * @param outcome - The failure, with its cause when there is one.
   * @throws ServiceUnavailableError when the policy fails closed.
   */
  private handleUnavailable(
    policy: RateLimitPolicy,
    outcome: Extract<ConsumeOutcome, { kind: 'unavailable' }>,
  ): void {
    const fields = { policy: policy.name, reason: outcome.reason };
    if (policy.failureMode === 'fail-open') {
      this.logger.warn(
        { ...fields, ...(outcome.error === undefined ? {} : { err: outcome.error }) },
        'rate limiter unavailable, request allowed',
      );
      return;
    }
    this.logger.warn(fields, 'rate limiter unavailable, request refused');
    throw new ServiceUnavailableError({
      retryAfterSeconds: RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS,
      ...(outcome.error === undefined ? {} : { cause: outcome.error }),
    });
  }
}
