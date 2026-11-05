# ADR-0005: RabbitMQ topology, publisher side (exchanges, alternate exchange, messages)

- **Status:** Proposed (a **[Rec]** decision from [`architecture.md`](../architecture.md) §6.1 and §14, not yet ratified). This version covers the **publisher side** only; consumer queues, retry and dead-letter are still to be decided and added here.
- **Date:** 2026-11-05
- **Deciders:** Project owner
- **Related:** [`architecture.md`](../architecture.md) §6.1, §8.1 and §14, [ADR-0007](0007-transactional-outbox.md), [ADR-0011](0011-event-contracts.md)

## Context and problem

The outbox relay (ADR-0007) publishes every event to RabbitMQ. A topic exchange with no queue bound for a routing key drops the message, and a publisher confirm still comes back as an ack, so an event with no consumer yet would be marked published and lost. Today that is every event: only auth-service publishes and nothing consumes. The compose stack defines no exchanges or queues, so the publisher must declare what it publishes to.

## Decision

### 1. One topic exchange per producing domain

- A producing service declares one durable topic exchange, `<domain>.events` (`auth.events`, `catalog.events`, `booking.events`, `payment.events`; `buildEventExchangeName`), and only its own.
- The routing key is the event `type`. The exchange is the producer's domain, not the first segment of the type (`user.registered` goes to `auth.events`), so the relay gets the domain from the service's configuration, never from a row.

### 2. Alternate exchange and catch-all queue

| Object | Name | Properties |
|---|---|---|
| Alternate exchange | `<domain>.events.unrouted` | durable, fanout |
| Catch-all queue | `<domain>.unrouted` | durable quorum queue bound to the alternate exchange, `x-message-ttl` 7 days, `x-max-length` 100000 |

- `<domain>.events` is declared with the argument `alternate-exchange` set to `<domain>.events.unrouted`. A message with no matching binding goes to the catch-all queue. That counts as routed, so the confirm is a real ack and the relay needs neither the `mandatory` flag nor return handling.
- The TTL and the length are starting values. They bound the queue's disk use; a message that expires or is pushed out is gone for good. Alerts on its depth and re-driving it are not decided here.

### 3. Declaration order and immutability

- The arguments of an exchange cannot change after it exists. Declaring it again with different arguments fails with `PRECONDITION_FAILED` and closes the channel. The **first declaration must therefore include `alternate-exchange`**. Adding it later means deleting the exchange, which also deletes its bindings, so every consumer would have to bind again.
- On every (re)connect the publisher declares, in this order: the alternate exchange, the catch-all queue and its binding, then `<domain>.events`. Declaring is idempotent when the arguments are equal, so it needs no existence check. The main exchange comes last so it never exists without its alternate.
- A changed argument in code against an existing exchange stops the relay at connect. That is intended: it is a topology migration, not something to redeclare silently. The queue's arguments are immutable in the same way.

### 4. Messages

- `persistent` (`deliveryMode` 2) on a durable exchange. The body is the outbox `payload` as is, `application/json`.
- Published on a confirm channel. The publish resolves on the broker's ack and rejects on a nack or a closed channel (`EventPublisher`). Only after the ack does the relay mark the row published (ADR-0007).
- `messageId` is the event `id`, the same value as the outbox row id and a consumer's inbox key. `type` (the event type) and `correlationId` (the envelope's) are set as well.
- `mandatory` is not set (see 2).

### 5. Consumers

A consuming service declares **its own** queues and bindings on the producer's exchange (`architecture.md` §6.1: one durable quorum queue per consuming service per exchange). The publisher never declares or binds a consumer queue. An event published before a consumer has bound its queue is not delivered to it; it sits in the catch-all queue until its TTL.

## Alternatives considered

| Option | Why not |
|---|---|
| `mandatory` flag, a return counts as a failed attempt | An event nobody consumes (`policy.updated`) becomes a failed row, and today every event would. |
| Alternate exchange set by a broker policy | A policy can change later, but the stack has no policy step (it defines no topology), so a first publish could come before it. |
| Publisher declares a queue per known consumer | Couples producers to consumers and contradicts "consumers declare their own queues". |

## Still open (not decided here)

- Consumer queues, bindings, retry queues, the dead-letter queue, prefetch, and what a consumer does with a message that fails its schema (§6.1, ADR-0011).
- Alerts on the catch-all depth, re-driving it once a consumer exists, and whether the TTL and length suit the demo.
- Whether Amazon MQ (`architecture.md` §15 item 2) accepts the same declarations.

## Consequences

- An event with no bound queue is kept for a bounded time instead of dropped, and a confirm stays truthful.
- The exchange arguments are frozen by the first declaration. Changing them is a manual migration.
- Each producing service owns three declarations (exchange, alternate exchange, queue) beside its relay.
- A late consumer does not see earlier events unless they are re-driven.

## Follow-ups

- Add the two extra names to `packages/messaging` topology names and the declaration to the relay.
- The RabbitMQ integration test (a container) is the **first test written in the relay code PR**. Its three assertions must pass before any other relay code depends on them: (1) redeclaring the exchange with changed arguments fails with `PRECONDITION_FAILED`; (2) a message with no bound queue is routed to the catch-all queue through the alternate exchange and the confirm is an ack; (3) the catch-all quorum queue accepts `x-message-ttl` and `x-max-length` and applies them. A failure changes this ADR, not the test.
- Update `architecture.md` §6.1 and §14 (done with this ADR).
