import { type Redis } from 'ioredis';
import { z } from 'zod';

import { type RateLimitDecision, type RateLimiter } from './rate-limiter';

/**
 * Counts one request and reads the time left, in one step so two replicas can never race.
 * The first request of a window sets the expiry; the PTTL check repairs a counter that somehow
 * has none, so a counter can never outlive its window and block a key forever.
 */
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

const SCRIPT_KEY_COUNT = 1;

/** The script's answer. Parsed, because a reply from another system is untrusted input. */
const ConsumeReply = z.tuple([z.number().int().positive(), z.number().int().nonnegative()]);

/** The one Redis command the limiter needs, so a test double stays small. */
export type RedisScriptRunner = Pick<Redis, 'eval'>;

/**
 * Fixed-window rate limiter on Redis. One counter per key with a TTL equal to the window: the first
 * request creates it, later ones increment it, and Redis deletes it when the window ends.
 */
export class RedisFixedWindowRateLimiter implements RateLimiter {
  /**
   * Creates a limiter on a Redis client.
   *
   * @param redis - A connected client. The caller owns it and closes it on shutdown.
   */
  constructor(private readonly redis: RedisScriptRunner) {}

  /**
   * Counts one request against a key. Atomic: concurrent callers get distinct counts.
   *
   * @param key - The counter to increment.
   * @param limit - Requests allowed per window.
   * @param windowMs - Window length in milliseconds.
   * @returns Whether the request is allowed and how long until the window ends.
   * @throws Error when Redis is unreachable, times out or answers with an unexpected shape.
   */
  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const reply = await this.redis.eval(CONSUME_SCRIPT, SCRIPT_KEY_COUNT, key, String(windowMs));
    const [count, retryAfterMs] = ConsumeReply.parse(reply);
    return {
      isAllowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      retryAfterMs,
    };
  }
}
