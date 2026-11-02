import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createTestApp } from '../../support/create-test-app';
import { type DependencyCheck } from '@/health/dependency-check';

const SECRET_DRIVER_MESSAGE = 'password authentication failed for user "auth_service" at 10.0.0.5';

function createUpCheck(name: string): DependencyCheck {
  return { name, check: () => Promise.resolve() };
}

function createDownCheck(name: string): DependencyCheck {
  return { name, check: () => Promise.reject(new Error(SECRET_DRIVER_MESSAGE)) };
}

function createHangingCheck(name: string): DependencyCheck {
  return { name, check: () => new Promise<void>(() => undefined) };
}

describe('GET /health/live', () => {
  it('answers 200 without touching any dependency', async () => {
    const { app } = createTestApp({ readinessChecks: [createDownCheck('postgres')] });

    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /health/ready', () => {
  it('answers 200 when every dependency is up', async () => {
    const { app } = createTestApp({
      readinessChecks: [createUpCheck('postgres'), createUpCheck('redis')],
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', checks: { postgres: 'up', redis: 'up' } });
  });

  it('answers 503 and names the dependency that is down', async () => {
    const { app } = createTestApp({
      readinessChecks: [createUpCheck('postgres'), createDownCheck('redis')],
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'unavailable',
      checks: { postgres: 'up', redis: 'down' },
    });
  });

  it('logs the real reason but never puts it in the response', async () => {
    const { app, lines } = createTestApp({ readinessChecks: [createDownCheck('postgres')] });

    const response = await request(app).get('/health/ready');

    expect(response.text).not.toMatch(/password|auth_service|10\.0\.0\.5/);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        dependency: 'postgres',
        err: expect.objectContaining({ message: SECRET_DRIVER_MESSAGE }) as unknown,
      }),
    );
  });

  it('counts a dependency that never answers as down', async () => {
    const { app } = createTestApp({
      readinessChecks: [createHangingCheck('redis')],
      checkTimeoutMs: 20,
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable', checks: { redis: 'down' } });
  });

  it('answers 503 while shutting down, without calling the dependencies', async () => {
    let wasChecked = false;
    const { app } = createTestApp({
      readinessChecks: [
        {
          name: 'postgres',
          check: () => {
            wasChecked = true;
            return Promise.resolve();
          },
        },
      ],
      isShuttingDown: () => true,
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'shutting_down', checks: {} });
    expect(wasChecked).toBe(false);
  });
});
