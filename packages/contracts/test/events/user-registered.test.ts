import { describe, expect, it } from 'vitest';

import { USER_REGISTERED_EVENT_TYPE, UserRegisteredData, UserRegisteredEvent } from '@/index';

const USER_ID = '0b9c5b0e-6a0d-4c2b-9d5e-3f1d6a7c8e90';
const EVENT_ID = '5d0f8f55-3d1c-4b0a-8a53-2f7b9c1e4a11';

/** A valid `user.registered` event. Tests override single fields to break one rule at a time. */
function buildValidEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID,
    type: 'user.registered',
    version: 1,
    occurredAt: '2026-11-04T10:00:00Z',
    aggregateId: USER_ID,
    aggregateVersion: 1,
    correlationId: 'req-123',
    causationId: null,
    tenantId: null,
    data: { userId: USER_ID, roleKey: 'CUSTOMER', registeredAt: '2026-11-04T10:00:00Z' },
    ...overrides,
  };
}

describe('USER_REGISTERED_EVENT_TYPE', () => {
  it('is the catalogue name from docs/architecture.md section 6.3', () => {
    expect(USER_REGISTERED_EVENT_TYPE).toBe('user.registered');
  });
});

describe('UserRegisteredData', () => {
  it('accepts a user id, a role key and a registration time', () => {
    const data = { userId: USER_ID, roleKey: 'CUSTOMER', registeredAt: '2026-11-04T10:00:00Z' };

    expect(UserRegisteredData.parse(data)).toEqual(data);
  });

  it('rejects an id that is not a UUID', () => {
    const result = UserRegisteredData.safeParse({
      userId: 'not-a-uuid',
      roleKey: 'CUSTOMER',
      registeredAt: '2026-11-04T10:00:00Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty role key', () => {
    const result = UserRegisteredData.safeParse({
      userId: USER_ID,
      roleKey: '',
      registeredAt: '2026-11-04T10:00:00Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a registration time without the UTC marker', () => {
    const result = UserRegisteredData.safeParse({
      userId: USER_ID,
      roleKey: 'CUSTOMER',
      registeredAt: '2026-11-04T10:00:00+02:00',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a missing field', () => {
    expect(UserRegisteredData.safeParse({ userId: USER_ID, roleKey: 'CUSTOMER' }).success).toBe(
      false,
    );
  });

  it('drops fields it does not know, so a newer producer cannot break an older consumer', () => {
    const parsed = UserRegisteredData.parse({
      userId: USER_ID,
      roleKey: 'CUSTOMER',
      registeredAt: '2026-11-04T10:00:00Z',
      addedLater: 'value',
    });

    expect(parsed).toEqual({
      userId: USER_ID,
      roleKey: 'CUSTOMER',
      registeredAt: '2026-11-04T10:00:00Z',
    });
  });
});

describe('UserRegisteredEvent', () => {
  it('accepts a valid event', () => {
    expect(UserRegisteredEvent.safeParse(buildValidEvent()).success).toBe(true);
  });

  it('accepts an operator tenant id', () => {
    const tenantId = '7c1e2f3a-4b5c-4d6e-8f70-1a2b3c4d5e6f';

    expect(UserRegisteredEvent.safeParse(buildValidEvent({ tenantId })).success).toBe(true);
  });

  it('rejects another event type', () => {
    expect(UserRegisteredEvent.safeParse(buildValidEvent({ type: 'user.deleted' })).success).toBe(
      false,
    );
  });

  it('rejects a version other than 1', () => {
    expect(UserRegisteredEvent.safeParse(buildValidEvent({ version: 2 })).success).toBe(false);
  });

  it('rejects an aggregate id that is not the id of the registered user', () => {
    const otherId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

    expect(UserRegisteredEvent.safeParse(buildValidEvent({ aggregateId: otherId })).success).toBe(
      false,
    );
  });

  it('reports the aggregate id mismatch on the aggregate id field', () => {
    const otherId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

    const result = UserRegisteredEvent.safeParse(buildValidEvent({ aggregateId: otherId }));

    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['aggregateId']);
  });

  it('rejects an envelope field that is missing', () => {
    const withoutCorrelationId = Object.fromEntries(
      Object.entries(buildValidEvent()).filter(([field]) => field !== 'correlationId'),
    );

    expect(UserRegisteredEvent.safeParse(withoutCorrelationId).success).toBe(false);
  });

  it('rejects a payload that does not match', () => {
    expect(UserRegisteredEvent.safeParse(buildValidEvent({ data: {} })).success).toBe(false);
  });
});
