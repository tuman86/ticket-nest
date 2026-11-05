import { describe, expect, it, vi } from 'vitest';

import { createReadinessChecks } from '@/health/create-readiness-checks';

describe('createReadinessChecks', () => {
  it('checks Postgres and Redis, in that order, and nothing else', () => {
    const checks = createReadinessChecks({
      pool: { query: () => Promise.resolve([]) },
      redis: { ping: () => Promise.resolve('PONG') },
    });

    expect(checks.map((check) => check.name)).toEqual(['postgres', 'redis']);
  });

  it('asks Postgres with SELECT 1 and pings Redis', async () => {
    const query = vi.fn(() => Promise.resolve([]));
    const ping = vi.fn(() => Promise.resolve('PONG'));
    const checks = createReadinessChecks({ pool: { query }, redis: { ping } });

    await Promise.all(checks.map((check) => check.check()));

    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('rejects when Redis does not answer', async () => {
    const checks = createReadinessChecks({
      pool: { query: () => Promise.resolve([]) },
      redis: { ping: () => Promise.reject(new Error('down')) },
    });
    const redisCheck = checks.find((check) => check.name === 'redis');

    await expect(redisCheck?.check()).rejects.toThrow('down');
  });
});
