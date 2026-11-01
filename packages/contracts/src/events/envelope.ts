import { z } from 'zod';

import { Id, Timestamp } from '../common';

/**
 * Envelope shared by every event on the bus (docs/architecture.md section 6.2).
 * Concrete events refine `data` and `type`; none are defined yet.
 */
export const EventEnvelope = z.object({
  id: Id,
  type: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/),
  version: z.int().positive(),
  occurredAt: Timestamp,
  aggregateId: z.string().min(1),
  aggregateVersion: z.int().nonnegative(),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).nullable(),
  tenantId: Id.nullable(),
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
