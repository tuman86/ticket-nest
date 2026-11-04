/** The two Redis client calls shutdown needs, so a test double stays small. */
export interface ClosableRedisClient {
  quit: () => Promise<unknown>;
  disconnect: () => void;
}

/**
 * Closes the Redis client during shutdown. Redis may be down (the rate limiter fails open), and
 * `QUIT` cannot be sent on a broken connection; that is no reason to report an unclean shutdown,
 * so the socket is dropped instead.
 *
 * @param client - The connected (or disconnected) Redis client.
 */
export async function closeRedisClient(client: ClosableRedisClient): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
