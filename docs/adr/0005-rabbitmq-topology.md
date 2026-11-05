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
- The routing key is the event `type`. The exchange is the producer's domain, not the first segment of the type (`user.registered` goes to `auth.events`), so the domain is a constant of the service, handed to the publisher when it is built, never read from a row.

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
- A changed argument in code against an existing exchange makes `connect()` fail with `TopologyDeclarationError` (ADR-0007). That is intended: it is a topology migration, not something to redeclare silently. Nothing is published while it lasts, the relay logs it at `error` on every tick, and the API keeps accepting writes into the outbox. The queue's arguments are immutable in the same way.

### 4. Messages

- `persistent` (`deliveryMode` 2) on a durable exchange. The body is the envelope as JSON (`application/json`), which equals the stored outbox `payload` because the writer stored it parsed.
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
- The RabbitMQ integration test of the three assertions was not written in the relay core PR, as this ADR first asked. It is the first test of the publisher PR (`packages/messaging/test/integration/relay/amqp-topology.test.ts`), written against plain amqplib so it checks the broker and not our code. On RabbitMQ 4.3.7 all three hold: (1) redeclaring the exchange with changed arguments, or without the alternate exchange, fails with `406 PRECONDITION_FAILED` ("inequivalent arg") and closes only that channel; (2) a message with no bound queue reaches the catch-all queue through the alternate exchange with its routing key, message id and body, and the confirm is an ack, whereas the same publish to an exchange without an alternate exchange is also acked but unroutable (a `mandatory` publish gets `basic.return` 312); (3) the catch-all is a durable quorum queue whose `x-message-ttl` and `x-max-length` the management API reports as declared, a different TTL is refused like any other changed argument, and a quorum queue with a TTL expires its messages and one with `x-max-length` drops the oldest.
- Update `architecture.md` §6.1 and §14 (done with this ADR).
