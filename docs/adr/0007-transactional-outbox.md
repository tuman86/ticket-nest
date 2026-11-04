# ADR-0007: Transactional outbox (polling relay) and inbox

- **Status:** Proposed (a **[Rec]** decision from [`architecture.md`](../architecture.md) §8 and §14, not yet ratified). This version records the producer side (the writer); the relay and the inbox are still to be decided and added here.
- **Date:** 2026-11-04
- **Deciders:** Project owner
- **Related:** [`architecture.md`](../architecture.md) §8, [ADR-0011](0011-event-contracts.md), `.claude/rules/data-access.md`

## Context and problem

A service must change its own data and tell the others about it. Writing to the database and then publishing to RabbitMQ are two systems, so a crash between them loses the event or publishes one for a change that never committed. The state change and the event must succeed or fail together.

## Decision

### Outbox writer (decided here)

- A service never calls the broker. It inserts an outbox row **in the same database transaction** as the state change, through `OutboxWriter.add(transaction, schema, event)` from `packages/messaging`. The writer needs the caller's transaction, so an event cannot be written without one.
- `packages/messaging` cannot import a service's Prisma client (each service generates its own). It defines `OutboxStore<TTransaction>`; each service implements it in `src/repositories/` over its own `outbox` table, with its own opaque transaction type.
- The writer takes the event's **schema** from `packages/contracts` and stores the schema's **parsed output**, not the input. A schema strips fields it does not declare, so a field that slipped into `data` (an email, a hash) is dropped before it reaches the table. An event that fails its schema throws `InvalidOutboxEventError` (a producer bug, HTTP 500) and nothing is stored. The error names failed fields only, never values.
- `EventEnvelopeBuilder` fills the `id` and `occurredAt` from an injected `IdGenerator` and `Clock`, so the caller owns only the business fields.

### Row shape

The row follows §8.1 with one change (§8.1 is updated to match): the **payload is the whole envelope**, and there is no separate `headers` column. The relay publishes the payload as is, so the message on the bus is exactly what the schema accepted and no code has to rebuild an envelope from columns that could drift from it. `id` is the event id, so the outbox row, the AMQP message id and a consumer's inbox key are the same value. `aggregate_type` is the first segment of the event type (`user` for `user.registered`). `aggregate_id`, `aggregate_version` and `type` repeat envelope values so the relay can order and filter without opening the JSON. The store adds `created_at`, `published_at` and `attempts`.

### Still open (not decided here)

- Relay: polling `FOR UPDATE SKIP LOCKED`, publisher confirms, per-aggregate ordering, retries and the janitor (§8.1).
- Inbox for consumers (§8.2).
- Exchange and queue topology (ADR-0005). `packages/messaging` only names the exchange (`auth.events`) so far.

## Consequences

- A producer cannot lose an event on a crash or publish one for a rolled-back change.
- Delivery stays at-least-once once the relay exists, so every consumer must tolerate duplicates.
- Every producing service carries an `outbox` table and a small `OutboxStore` implementation.
- The writer only guards against undeclared fields because the schemas strip them. Its types refuse a schema whose `type` is not a literal or whose `data` is `unknown` (the base `EventEnvelope`), but they cannot see whether a concrete schema is loose. Each event therefore needs a test that its stored payload has exactly the expected keys.
