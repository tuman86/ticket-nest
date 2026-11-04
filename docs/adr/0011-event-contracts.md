# ADR-0011: Event contracts: envelope, Zod schemas, versioning

- **Status:** Proposed (a **[Rec]** decision from [`architecture.md`](../architecture.md) §6.2 and §14, not yet ratified)
- **Date:** 2026-11-04
- **Deciders:** Project owner
- **Related:** [`architecture.md`](../architecture.md) §6, §8 and §14 (the planned ADR-0005 for the broker topology and ADR-0007 for the outbox), ADR-0013

## Context and problem

Services talk through events on RabbitMQ. Producers and consumers are separate deployments, so they need one agreed shape for a message, a way to check it at the boundary, and rules for changing it without breaking a consumer that has not been updated yet.

## Decision

### Envelope

Every event uses the envelope in [`architecture.md`](../architecture.md) §6.2, defined once as `EventEnvelope` in `packages/contracts/src/events/envelope.ts`: `id`, `type`, `version`, `occurredAt` (UTC, ends in `Z`), `aggregateId`, `aggregateVersion`, `correlationId`, `causationId` (null when nothing caused the event), `tenantId` (null for events that belong to no operator) and `data`.

### One schema per event

- Each event is `EventEnvelope.extend({ type: z.literal(...), version: z.literal(n), data: ... })` in its own file under `packages/contracts/src/events/`, and is exported from the package.
- `type` is the catalogue name from §6.3 and is also the RabbitMQ routing key.
- Producers build events through the schema, and consumers parse every incoming message with it. What happens to a message that fails to parse (retry or dead-letter queue) is decided with the broker topology, not here.
- When an event's aggregate is the entity in its payload, the schema checks that `aggregateId` equals that entity's id (`user.registered`: `data.userId`).
- The Zod schemas are hand-maintained. There is no OpenAPI for events.

### Versioning

- Compatible changes only add optional fields. The `data` object is **not** strict, so a consumer built against an older schema drops fields it does not know instead of failing.
- A breaking change gets a new `version` and its own schema. The producer publishes both versions until every consumer has moved. `version` is a literal in each schema, so a consumer rejects a version it cannot read.

### Payload content

- Payloads state facts and carry what consumers need, in line with the "fat events" idea in §5.1, **except for personal data**. `.claude/rules/security.md` forbids personal data and secrets in events, so identifiers go in the event and a consumer that needs contact details fetches them from the owning service.
- `user.registered` is the first event and follows this rule: `userId`, `roleKey` and `registeredAt` only. A welcome email therefore needs a lookup (or a later event) when notification-service is built. This trade-off is accepted for now and should be revisited with that service.

## Consequences

- Adding a field is cheap and safe. Renaming or removing one needs a new version and a migration period.
- Consumers cannot rely on the event alone for contact details, which adds a call from notification to auth-service.
- There is no automatic check that a producer's output matches a consumer's expectations. Contract tests between services would close that gap.
