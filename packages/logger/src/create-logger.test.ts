import { describe, expect, it } from 'vitest';

import { runWithCorrelationId } from './correlation-context';
import { createLogger, type CreateLoggerOptions } from './create-logger';

type LogLine = Record<string, unknown>;

function createCollector(): { lines: LogLine[]; destination: { write: (line: string) => void } } {
  const lines: LogLine[] = [];
  return {
    lines,
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
  };
}

function createCollectingLogger(overrides: Partial<CreateLoggerOptions> = {}) {
  const { lines, destination } = createCollector();
  const logger = createLogger({
    serviceName: 'booking-service',
    level: 'info',
    nodeEnvironment: 'test',
    destination,
    ...overrides,
  });
  return { logger, lines };
}

function firstLine(lines: LogLine[]): LogLine {
  const [line] = lines;
  if (line === undefined) {
    throw new Error('expected a log line');
  }
  return line;
}

describe('createLogger output', () => {
  it('writes JSON with service, ISO time and a string level', () => {
    const { logger, lines } = createCollectingLogger();
    logger.info({ bookingId: 'b-1' }, 'hold created');

    const line = firstLine(lines);
    expect(line).toMatchObject({
      level: 'info',
      service: 'booking-service',
      bookingId: 'b-1',
      msg: 'hold created',
    });
    expect(new Date(String(line.time)).toISOString()).toBe(line.time);
    expect(line).not.toHaveProperty('pid');
    expect(line).not.toHaveProperty('hostname');
  });

  it('drops lines below the configured level', () => {
    const { logger, lines } = createCollectingLogger({ level: 'warn' });
    logger.info('ignored');
    logger.warn('kept');

    expect(lines.map((line) => line.msg)).toEqual(['kept']);
  });

  it('emits nothing at level silent', () => {
    const { logger, lines } = createCollectingLogger({ level: 'silent' });
    logger.fatal('ignored');

    expect(lines).toEqual([]);
  });

  it('serializes errors under err with type, message and stack', () => {
    const { logger, lines } = createCollectingLogger();
    logger.error({ err: new TypeError('boom') }, 'failed');

    expect(firstLine(lines).err).toMatchObject({ type: 'TypeError', message: 'boom' });
    expect(firstLine(lines).err).toHaveProperty('stack');
  });
});

describe('createLogger correlation id', () => {
  it('adds correlationId inside a context, across awaits and child loggers', async () => {
    const { logger, lines } = createCollectingLogger();

    await runWithCorrelationId('corr-1', async () => {
      await Promise.resolve();
      logger.info('after await');
      logger.child({ component: 'sweeper' }).info('from child');
    });

    expect(lines.map((line) => line.correlationId)).toEqual(['corr-1', 'corr-1']);
    expect(lines[1]).toMatchObject({ component: 'sweeper' });
  });

  it('keeps concurrent contexts apart', async () => {
    const { logger, lines } = createCollectingLogger();

    await Promise.all(
      ['corr-a', 'corr-b'].map((id) =>
        runWithCorrelationId(id, async () => {
          await new Promise((resolve) => setTimeout(resolve, id === 'corr-a' ? 5 : 1));
          logger.info({ owner: id }, 'tick');
        }),
      ),
    );

    for (const line of lines) {
      expect(line.correlationId).toBe(line.owner);
    }
    expect(lines).toHaveLength(2);
  });

  it('omits correlationId outside a context', () => {
    const { logger, lines } = createCollectingLogger();
    logger.info('no context');

    expect(firstLine(lines)).not.toHaveProperty('correlationId');
  });
});

describe('createLogger redaction', () => {
  const REDACTED = '[REDACTED]';

  it.each([
    'password',
    'newPassword',
    'token',
    'accessToken',
    'refreshToken',
    'otp',
    'secret',
    'clientSecret',
    'authorization',
    'cookie',
  ])('redacts %s at the top level and one level down', (key) => {
    const { logger, lines } = createCollectingLogger();
    logger.info({ [key]: 'top-secret', user: { [key]: 'nested-secret', email: 'a@b.test' } }, 'x');

    const line = firstLine(lines);
    expect(line[key]).toBe(REDACTED);
    expect(line.user).toEqual({ [key]: REDACTED, email: 'a@b.test' });
    expect(JSON.stringify(line)).not.toMatch(/top-secret|nested-secret/);
  });

  it('redacts authorization and cookie request headers', () => {
    const { logger, lines } = createCollectingLogger();
    logger.info(
      {
        req: {
          headers: { authorization: 'Bearer abc', cookie: 'sid=1', 'x-request-id': 'corr-1' },
        },
        res: { headers: { 'set-cookie': 'sid=1' } },
      },
      'request',
    );

    expect(firstLine(lines)).toMatchObject({
      req: { headers: { authorization: REDACTED, cookie: REDACTED, 'x-request-id': 'corr-1' } },
      res: { headers: { 'set-cookie': REDACTED } },
    });
  });

  it('does not mutate the object passed in', () => {
    const { logger } = createCollectingLogger();
    const payload = { password: 'hunter2', name: 'Ada' };
    logger.info(payload, 'x');

    expect(payload).toEqual({ password: 'hunter2', name: 'Ada' });
  });

  it('documents the depth limit: keys nested two levels deep are not redacted', () => {
    const { logger, lines } = createCollectingLogger();
    logger.info({ a: { b: { password: 'deep' } } }, 'x');

    expect(firstLine(lines).a).toEqual({ b: { password: 'deep' } });
  });
});
