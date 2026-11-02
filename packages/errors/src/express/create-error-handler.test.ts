import { type AddressInfo } from 'node:net';

import { Problem } from '@ticketnest/contracts';
import express, { type Express, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { fromZodError } from '../from-zod-error';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../http-errors';
import { createErrorHandler, type CreateErrorHandlerOptions } from './create-error-handler';
import { handleUnmatchedRoute } from './handle-unmatched-route';

const SECRET_MESSAGE = 'connect to postgres://user:hunter2@db failed';
const JSON_LIMIT = '1kb';

const stopServers: (() => void)[] = [];

afterEach(() => {
  for (const stop of stopServers.splice(0)) {
    stop();
  }
});

function createLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

function buildApp(options: Partial<CreateErrorHandlerOptions> = {}) {
  const logger = createLogger();
  const app = express();
  app.use(express.json({ limit: JSON_LIMIT }));

  app.get('/v1/not-found', () => {
    throw new NotFoundError({ detail: 'Booking not found.' });
  });
  app.get('/v1/unauthorized', () => {
    throw new UnauthorizedError();
  });
  app.get('/v1/forbidden', () => {
    throw new ForbiddenError();
  });
  app.get('/v1/async-conflict', async () => {
    await Promise.resolve();
    throw new ConflictError({ code: 'SEAT_UNAVAILABLE' });
  });
  app.get('/v1/invalid', () => {
    const result = z.object({ email: z.email() }).safeParse({});
    if (!result.success) {
      throw fromZodError(result.error, 'query');
    }
  });
  app.get('/v1/boom', () => {
    throw new Error(SECRET_MESSAGE);
  });
  app.post('/v1/echo', (request, response) => {
    response.json(request.body);
  });
  app.use(handleUnmatchedRoute);
  app.use(createErrorHandler({ logger, getCorrelationId: () => 'corr-123', ...options }));
  return { app, logger };
}

async function listen(app: Express): Promise<string> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  stopServers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function readProblem(response: Response | globalThis.Response): Promise<Problem> {
  return Problem.parse(await response.json());
}

describe('createErrorHandler', () => {
  it.each([
    ['/v1/not-found', 404, 'NOT_FOUND'],
    ['/v1/unauthorized', 401, 'UNAUTHENTICATED'],
    ['/v1/forbidden', 403, 'FORBIDDEN'],
    ['/v1/async-conflict', 409, 'SEAT_UNAVAILABLE'],
    ['/v1/invalid', 422, 'VALIDATION_ERROR'],
  ])('answers %s with problem+json (%i %s)', async (path, status, code) => {
    const baseUrl = await listen(buildApp().app);
    const response = await fetch(`${baseUrl}${path}`);

    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await readProblem(response)).toMatchObject({ status, code, instance: path });
  });

  it('sends a Bearer challenge on 401', async () => {
    const baseUrl = await listen(buildApp().app);
    const response = await fetch(`${baseUrl}/v1/unauthorized`);

    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('lists the invalid fields on a validation error', async () => {
    const baseUrl = await listen(buildApp().app);
    const problem = await readProblem(await fetch(`${baseUrl}/v1/invalid`));

    expect(problem.errors).toEqual([
      expect.objectContaining({ pointer: '#/query/email', code: 'REQUIRED' }),
    ]);
  });

  it('puts the correlation id in the body and echoes X-Request-Id', async () => {
    const baseUrl = await listen(buildApp().app);
    const response = await fetch(`${baseUrl}/v1/not-found`);

    expect(response.headers.get('x-request-id')).toBe('corr-123');
    expect((await readProblem(response)).correlationId).toBe('corr-123');
  });

  it('falls back to a safe X-Request-Id header, and ignores an unsafe one', async () => {
    const baseUrl = await listen(buildApp({ getCorrelationId: () => undefined }).app);

    const fromHeader = await fetch(`${baseUrl}/v1/not-found`, {
      headers: { 'X-Request-Id': 'from-gateway-1' },
    });
    const unsafe = await fetch(`${baseUrl}/v1/not-found`, {
      headers: { 'X-Request-Id': 'bad id!' },
    });

    expect((await readProblem(fromHeader)).correlationId).toBe('from-gateway-1');
    expect((await readProblem(unsafe)).correlationId).toBeUndefined();
    expect(unsafe.headers.get('x-request-id')).toBeNull();
  });

  it('keeps the query string out of instance', async () => {
    const baseUrl = await listen(buildApp().app);
    const response = await fetch(`${baseUrl}/v1/not-found?token=abc123`);
    const text = await response.text();

    expect(text).toContain('"instance":"/v1/not-found"');
    expect(text).not.toContain('abc123');
  });
});

describe('createErrorHandler with unexpected errors', () => {
  it('returns a generic 500 that leaks nothing', async () => {
    const baseUrl = await listen(buildApp().app);
    const response = await fetch(`${baseUrl}/v1/boom`);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(Problem.parse(JSON.parse(text))).toEqual({
      type: 'https://api.ticketnest.example/problems/internal-error',
      title: 'Internal server error',
      status: 500,
      code: 'INTERNAL_ERROR',
      instance: '/v1/boom',
      correlationId: 'corr-123',
    });
    expect(text).not.toMatch(/hunter2|postgres|stack|Error:|\.ts/);
  });

  it('adds the message and stack only when debug info is exposed', async () => {
    const baseUrl = await listen(buildApp({ isDebugInfoExposed: true }).app);
    const problem = await readProblem(await fetch(`${baseUrl}/v1/boom`));

    expect(problem.detail).toBe(SECRET_MESSAGE);
    expect(problem.stack).toEqual(expect.stringContaining('Error'));
  });

  it('does not expose debug info on client errors even when enabled', async () => {
    const baseUrl = await listen(buildApp({ isDebugInfoExposed: true }).app);
    const problem = await readProblem(await fetch(`${baseUrl}/v1/not-found`));

    expect(problem).not.toHaveProperty('stack');
  });

  it('logs server errors at error level with the original error', async () => {
    const { app, logger } = buildApp();
    await fetch(`${await listen(app)}/v1/boom`);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: SECRET_MESSAGE }) as unknown,
      }),
      'request failed',
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs client errors at info level without the error object', async () => {
    const { app, logger } = buildApp();
    await fetch(`${await listen(app)}/v1/not-found`);

    expect(logger.info).toHaveBeenCalledWith(
      { status: 404, code: 'NOT_FOUND' },
      'request rejected',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('createErrorHandler with Express errors', () => {
  it('answers unparseable JSON with 400 MALFORMED_REQUEST', async () => {
    const baseUrl = await listen(buildApp().app);
    const response = await fetch(`${baseUrl}/v1/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken": ',
    });

    expect(response.status).toBe(400);
    expect(await readProblem(response)).toMatchObject({
      code: 'MALFORMED_REQUEST',
      detail: 'Request body is not valid JSON.',
    });
  });

  it('answers an oversized body with 413 REQUEST_REJECTED', async () => {
    const baseUrl = await listen(buildApp().app);
    const response = await fetch(`${baseUrl}/v1/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filler: 'x'.repeat(2000) }),
    });

    expect(response.status).toBe(413);
    expect(await readProblem(response)).toMatchObject({
      code: 'REQUEST_REJECTED',
      status: 413,
      title: 'Payload Too Large',
    });
  });

  it('answers an unmatched route with a 404 problem', async () => {
    const baseUrl = await listen(buildApp().app);
    const response = await fetch(`${baseUrl}/v1/nothing-here`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await readProblem(response)).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('hands the error to Express when the response has already started', () => {
    const { logger } = buildApp();
    const handler = createErrorHandler({ logger, getCorrelationId: () => undefined });
    const next = vi.fn();
    const error = new ValidationError([{ pointer: '#', code: 'INVALID_VALUE', detail: 'x' }]);

    handler(error, {} as Request, { headersSent: true } as Response, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
