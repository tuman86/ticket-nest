import { describe, expect, it, vi } from 'vitest';

import { closeRedisClient } from '@/close-redis-client';

describe('closeRedisClient', () => {
  it('sends QUIT and does not force a disconnect when Redis is healthy', async () => {
    const client = { quit: vi.fn().mockResolvedValue('OK'), disconnect: vi.fn() };

    await closeRedisClient(client);

    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('drops the socket instead of failing when QUIT cannot be sent, because Redis is down', async () => {
    const client = {
      quit: vi.fn().mockRejectedValue(new Error("Stream isn't writeable")),
      disconnect: vi.fn(),
    };

    await expect(closeRedisClient(client)).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
});
