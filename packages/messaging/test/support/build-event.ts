export const USER_ID = '0b9c5b0e-6a0d-4c2b-9d5e-3f1d6a7c8e90';
export const EVENT_ID = '5d0f8f55-3d1c-4b0a-8a53-2f7b9c1e4a11';
export const EVENT_CORRELATION_ID = 'req-123';

const UUID_LAST_GROUP_LENGTH = 12;

/**
 * @param sequenceNumber - A small number that makes the id unique within a test.
 * @returns A valid UUID, for example `00000000-0000-4000-8000-0000000000a1` style ids.
 */
export function buildEventId(sequenceNumber: number): string {
  return `00000000-0000-4000-8000-${String(sequenceNumber).padStart(UUID_LAST_GROUP_LENGTH, '0')}`;
}

/**
 * Builds a valid `user.registered` envelope as the outbox stores it.
 *
 * @param overrides - Fields that replace the valid ones, to break one rule at a time.
 * @returns A plain object, the shape of a stored outbox payload.
 */
export function buildStoredEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID,
    type: 'user.registered',
    version: 1,
    occurredAt: '2026-11-04T10:00:00Z',
    aggregateId: USER_ID,
    aggregateVersion: 1,
    correlationId: EVENT_CORRELATION_ID,
    causationId: null,
    tenantId: null,
    data: { userId: USER_ID, roleKey: 'CUSTOMER', registeredAt: '2026-11-04T10:00:00Z' },
    ...overrides,
  };
}
