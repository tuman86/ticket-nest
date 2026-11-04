import { z } from 'zod';

import { Id, Timestamp } from '../common';

import { EventEnvelope } from './envelope';

/** Catalogue name of the event (docs/architecture.md section 6.3). Also its routing key. */
export const USER_REGISTERED_EVENT_TYPE = 'user.registered';

/** Schema version of `user.registered`. Producers stamp it on the envelope; the schema accepts only this one. */
export const USER_REGISTERED_EVENT_VERSION = 1;

/**
 * Payload of `user.registered`: identifiers only.
 *
 * It carries no email, name, phone or password hash on purpose (`.claude/rules/security.md`:
 * no personal data in events). A consumer that needs contact details, such as a welcome email,
 * must fetch them from auth-service. Fields may be added later, so this object is not strict and
 * an older consumer drops what it does not know.
 */
export const UserRegisteredData = z.object({
  /** The new user. Also the aggregate id of the event. */
  userId: Id,
  /** Key of the role the account was created with (`CUSTOMER` for self-registration). */
  roleKey: z.string().min(1),
  /** When the account was created. */
  registeredAt: Timestamp,
});
export type UserRegisteredData = z.infer<typeof UserRegisteredData>;

/**
 * Event published by auth-service when a customer account is created. Consumers: booking (merge
 * of earlier guest bookings) and notification (welcome message).
 *
 * The aggregate is the user, so `aggregateId` must equal `data.userId`; a mismatch is rejected.
 */
export const UserRegisteredEvent = EventEnvelope.extend({
  type: z.literal(USER_REGISTERED_EVENT_TYPE),
  version: z.literal(USER_REGISTERED_EVENT_VERSION),
  data: UserRegisteredData,
}).refine((event) => event.aggregateId === event.data.userId, {
  path: ['aggregateId'],
  error: 'aggregateId must equal data.userId',
});
export type UserRegisteredEvent = z.infer<typeof UserRegisteredEvent>;
