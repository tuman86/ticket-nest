import { describe, expect, it } from 'vitest';

import { EventEnvelope, Money, PageQuery, Problem, ValidationProblem, pageOf, Id } from './index';

describe('Money', () => {
  it('accepts integer minor units', () => {
    expect(Money.safeParse({ amountMinor: 2500, currency: 'USD' }).success).toBe(true);
  });

  it('rejects fractional and negative amounts', () => {
    expect(Money.safeParse({ amountMinor: 10.5, currency: 'USD' }).success).toBe(false);
    expect(Money.safeParse({ amountMinor: -1, currency: 'USD' }).success).toBe(false);
  });
});

describe('PageQuery', () => {
  it('defaults limit to 25 and coerces strings', () => {
    expect(PageQuery.parse({}).limit).toBe(25);
    expect(PageQuery.parse({ limit: '50' }).limit).toBe(50);
  });

  it('rejects limits above 100', () => {
    expect(PageQuery.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('pageOf', () => {
  it('wraps items in the data/page envelope', () => {
    const schema = pageOf(Id);
    const result = schema.safeParse({
      data: ['0b1f7c3e-0c5b-4a76-9d51-5f2c0e8f9a11'],
      page: { limit: 25, nextCursor: null, hasMore: false },
    });
    expect(result.success).toBe(true);
  });
});

describe('Problem', () => {
  const base = {
    type: 'https://api.ticketnest.example/problems/not-found',
    title: 'Resource not found',
    status: 404,
  };

  it('accepts RFC 9457 problems with extensions', () => {
    expect(Problem.safeParse({ ...base, code: 'NOT_FOUND', extra: 1 }).success).toBe(true);
  });

  it('requires per-field errors on a ValidationProblem', () => {
    expect(ValidationProblem.safeParse({ ...base, status: 422 }).success).toBe(false);
    expect(
      ValidationProblem.safeParse({
        ...base,
        status: 422,
        errors: [{ pointer: '#/email', code: 'INVALID_FORMAT', detail: 'Invalid email' }],
      }).success,
    ).toBe(true);
  });
});

describe('EventEnvelope', () => {
  it('validates the shared envelope', () => {
    const result = EventEnvelope.safeParse({
      id: '0b1f7c3e-0c5b-4a76-9d51-5f2c0e8f9a11',
      type: 'booking.confirmed',
      version: 1,
      occurredAt: '2026-11-01T10:00:00Z',
      aggregateId: 'booking-1',
      aggregateVersion: 4,
      correlationId: 'corr-1',
      causationId: null,
      tenantId: null,
      data: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-UTC timestamps', () => {
    const result = EventEnvelope.safeParse({
      id: '0b1f7c3e-0c5b-4a76-9d51-5f2c0e8f9a11',
      type: 'booking.confirmed',
      version: 1,
      occurredAt: '2026-11-01T10:00:00+05:30',
      aggregateId: 'booking-1',
      aggregateVersion: 4,
      correlationId: 'corr-1',
      causationId: null,
      tenantId: null,
      data: {},
    });
    expect(result.success).toBe(false);
  });
});
