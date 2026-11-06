import { describe, expect, it, vi } from 'vitest';

import { createPostgresCheck } from '@/health/postgres-check';

describe('createPostgresCheck', () => {
  it('is named postgres, the key of the readiness report', () => {
    const check = createPostgresCheck({ query: () => Promise.resolve([]) });

    expect(check.name).toBe('postgres');
  });

  it('asks the database SELECT 1, and only when the check runs', async () => {
    const query = vi.fn(() => Promise.resolve([]));
    const check = createPostgresCheck({ query });
    expect(query).not.toHaveBeenCalled();

    await check.check();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('resolves when the database answers', async () => {
    const check = createPostgresCheck({ query: () => Promise.resolve([{ '?column?': 1 }]) });

    await expect(check.check()).resolves.toBeUndefined();
  });

  it('rejects when the query fails, so the health router reports the database as down', async () => {
    const check = createPostgresCheck({
      query: () => Promise.reject(new Error('connection lost')),
    });

    await expect(check.check()).rejects.toThrow('connection lost');
  });
});
