import { Redis } from 'ioredis';

const COMMAND_TIMEOUT_MS = 2_000;

/**
 * Connects to the test container's Redis and waits until it is ready, because with the offline
 * queue off (as in production) a command sent before the connection is up is rejected.
 *
 * @param redisUrl - The URL from `inject('redisUrl')`.
 * @returns A connected client that fails fast, which the test must close with `quit()`.
 */
export async function createTestRedis(redisUrl: string): Promise<Redis> {
  const redis = new Redis(redisUrl, {
    commandTimeout: COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  await redis.connect();
  return redis;
}
