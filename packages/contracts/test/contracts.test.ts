import { describe, expect, it } from 'vitest';

import {
  EventEnvelope,
  Money,
  PageQuery,
  Problem,
  RegisterRequest,
  UserResponse,
  ValidationProblem,
  pageOf,
  Id,
} from '@/index';

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

describe('RegisterRequest', () => {
  const valid = { email: 'asha@example.com', password: 'correct-horse-battery', name: 'Asha Rao' };

  it('accepts a body with and without a phone', () => {
    expect(RegisterRequest.safeParse(valid).success).toBe(true);
    expect(RegisterRequest.safeParse({ ...valid, phone: '+919876543210' }).success).toBe(true);
  });

  it('accepts a password of exactly 10 and 128 characters', () => {
    expect(RegisterRequest.safeParse({ ...valid, password: 'a'.repeat(10) }).success).toBe(true);
    expect(RegisterRequest.safeParse({ ...valid, password: 'a'.repeat(128) }).success).toBe(true);
  });

  it('rejects a password of 9 or 129 characters', () => {
    expect(RegisterRequest.safeParse({ ...valid, password: 'a'.repeat(9) }).success).toBe(false);
    expect(RegisterRequest.safeParse({ ...valid, password: 'a'.repeat(129) }).success).toBe(false);
  });

  it.each(['role', 'tenantId', 'passwordHash', 'status'])('rejects the unknown key %s', (key) => {
    expect(RegisterRequest.safeParse({ ...valid, [key]: 'x' }).success).toBe(false);
  });

  it.each([
    ['email', 'not-an-email'],
    ['email', `${'a'.repeat(250)}@example.com`],
    ['name', ''],
    ['name', '   '],
    ['name', 'n'.repeat(101)],
    ['phone', '9876543210'],
    ['phone', '+0123456789'],
  ])('rejects an invalid %s: %j', (field, value) => {
    expect(RegisterRequest.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });

  it('trims the name', () => {
    expect(RegisterRequest.parse({ ...valid, name: '  Asha Rao ' }).name).toBe('Asha Rao');
  });
});

describe('UserResponse', () => {
  const user = {
    id: '4b0d2f0e-8f0c-4d0e-9a6f-0c2f6a5d1e11',
    email: 'asha@example.com',
    emailVerified: false,
    name: 'Asha Rao',
    phone: null,
    role: { id: '7c1a9b52-1c47-4e0a-8a3b-6d3e1f0b2a10', key: 'CUSTOMER', name: 'Customer' },
    tenantId: null,
    status: 'ACTIVE',
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:00:00Z',
  };

  it('accepts the documented example', () => {
    expect(UserResponse.safeParse(user).success).toBe(true);
  });

  it('strips fields it does not know, so a password hash cannot leak', () => {
    const parsed = UserResponse.parse({ ...user, passwordHash: '$argon2id$x', password: 'x' });
    expect(parsed).not.toHaveProperty('passwordHash');
    expect(parsed).not.toHaveProperty('password');
  });
});
