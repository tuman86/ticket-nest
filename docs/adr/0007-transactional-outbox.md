# ADR-0007: Transactional outbox (polling relay) and inbox

- **Status:** Proposed (a **[Rec]** decision from [`architecture.md`](../architecture.md) §8 and §14, not yet ratified). This version records the producer side: the writer and the relay, both built (the relay core, auth-service's store, the AMQP publisher and auth-service's wiring, with a runbook for failed rows). The inbox is still to be decided and added here.
- **Date:** 2026-11-04 (relay section added 2026-11-05)
- **Deciders:** Project owner
- **Related:** [`architecture.md`](../architecture.md) §6.1, §8 and §14, [ADR-0005](0005-rabbitmq-topology.md), [ADR-0011](0011-event-contracts.md), [ADR-0012](0012-money-and-time.md), `.claude/rules/data-access.md`

## Context and problem

A service must change its own data and tell the others about it. Writing to the database and then publishing to RabbitMQ are two systems, so a crash between them loses the event or publishes one for a change that never committed. The state change and the event must succeed or fail together.

## Decision

### Outbox writer (decided here)

- A service never calls the broker. It inserts an outbox row **in the same database transaction** as the state change, through `OutboxWriter.add(transaction, schema, event)` from `packages/messaging`. The writer needs the caller's transaction, so an event cannot be written without one.
- `packages/messaging` cannot import a service's Prisma client (each service generates its own). It defines `OutboxStore<TTransaction>`; each service implements it in `src/repositories/` over its own `outbox` table, with its own opaque transaction type.
- The writer takes the event's **schema** from `packages/contracts` and stores the schema's **parsed output**, not the input. A schema strips fields it does not declare, so a field that slipped into `data` (an email, a hash) is dropped before it reaches the table. An event that fails its schema throws `InvalidOutboxEventError` (a producer bug, HTTP 500) and nothing is stored. The error names failed fields only, never values.
- `EventEnvelopeBuilder` fills the `id` and `occurredAt` from an injected `IdGenerator` and `Clock`, so the caller owns only the business fields.

### Row shape

The row follows §8.1 with one change (§8.1 is updated to match): the **payload is the whole envelope**, and there is no separate `headers` column. The relay publishes the payload as is, so the message on the bus is exactly what the schema accepted and no code has to rebuild an envelope from columns that could drift from it. `id` is the event id, so the outbox row, the AMQP message id and a consumer's inbox key are the same value. `aggregate_type` is the first segment of the event type (`user` for `user.registered`). `aggregate_id`, `aggregate_version` and `type` repeat envelope values so the relay can order and filter without opening the JSON. The store adds `created_at`, `published_at` and `attempts`. The relay adds three nullable columns, `locked_until` (`timestamptz(3)`), `locked_by` (`text`, because an `IdGenerator` may return any string) and `failed_at` (`timestamptz(3)`), see "Relay". In auth-service they come from the migration `add_outbox_relay_columns`.

### First use: auth-service `user.registered`

- `PrismaOutboxRepository` implements `OutboxStore` over the `outbox` table (migration `add_outbox`). It has no client of its own and writes only through the client bound to the transaction it is given, so a row cannot be committed apart from its state change. A handle that did not come from `PrismaUnitOfWork` is refused with a `TypeError` before anything is written.
- `RegisterService` calls `UserRegisteredEventRecorder.record(tx, user, role)` inside the same `unitOfWork.run` as `userRepository.create`. If the event cannot be written, the user is not created and the request answers 500.
- The table has a unique index on `(aggregate_type, aggregate_id, aggregate_version)`, which keeps one event per aggregate version, and a plain index on `(published_at, created_at)` for the relay. A partial index (`WHERE published_at IS NULL`) would be smaller, but Prisma cannot express it, so `migrate dev` would report drift. The claim query now exists (it also filters on `failed_at` and `locked_until`), and the relay migration adds **no index**: the unpublished rows are a thin tail of the table, a poll reads at most 500 of them, and nothing measures the table yet. Revisit when the table grows or the claim shows up as slow.
- The correlation id is the request's `X-Request-Id`, which `handleRequestId` accepts only as 1 to 128 word characters, dots or hyphens, so the value stored is bounded at the source.
- Rows stay unpublished while the relay is disabled (`OUTBOX_RELAY_ENABLED=false`). Otherwise auth-service's relay publishes them (see "Relay").

### Relay (decided here and built in `packages/messaging`; auth-service runs it)

**Claim: a lease, no held transaction.**

- One statement, a `$queryRaw` tagged template (never `$queryRawUnsafe`, `security.md`), claims a batch: `UPDATE outbox SET locked_until = now() + <lease>, locked_by = <claimId> WHERE id IN (SELECT id FROM outbox WHERE published_at IS NULL AND failed_at IS NULL AND (locked_until IS NULL OR locked_until < now()) ORDER BY created_at, aggregate_version LIMIT <n> FOR UPDATE SKIP LOCKED) RETURNING …`. The row locks live for that one statement only.
- The relay publishes **outside any transaction**, then sets `published_at` in a second statement after the broker's confirm. No network call runs inside a transaction (`data-access.md`), and no pooled connection or row lock is held while the broker answers. `UnitOfWork.run` passes no timeout to Prisma's interactive transaction, so a held transaction would also run under the default timeout.
- A replica that crashes mid-batch leaves its rows leased. They become claimable again when `locked_until` passes.
- The SQL lives in `PrismaOutboxRelayRepository` in `src/repositories/`, beside `PrismaOutboxRepository`. It is the only code that touches the claim columns. Unlike the other repositories it takes the shared `PrismaClient` and no transaction handle, because each of its statements stands alone. It sorts the claimed rows by `created_at` and `aggregate_version` itself, since `UPDATE … RETURNING` promises no order, and parses them with Zod before handing them on.

**Why the lease uses the database clock, despite ADR-0012 rule 3.** Rule 3 keeps `now()` out of the database for business rules (a cutoff, a refund window) so those rules are pure functions that tests run with a fixed clock and no database. A lease is not a business rule. It is a coordination value that several replicas compare through SQL, and the comparison `locked_until < now()` already runs inside the database. If each replica used its own clock, NTP drift between replicas, which ADR-0012 accepts for the shortest cutoff, could make one replica reclaim rows another still holds, or leave them stuck longer than intended. One time source removes that. The relay's own logic (batching, backoff, when to give up) takes an injected random source and sleep function, and no clock, and is tested with fakes, so ADR-0012's testability aim still holds. It passes only durations to the store (the lease and the retry delay in milliseconds); the database adds them to its own `now()`. `published_at` is written with the database's `now()` too, like the `created_at` default.

**What the `claimId` guard prevents.** Each claim gets a fresh id (from the `IdGenerator`) stored in `locked_by`. `markPublished`, `recordFailure` and `markFailed` all add `AND locked_by = <claimId>` to their `WHERE`. If a replica stalls so long that its lease expires (a broker pause beyond the lease, a long garbage collection), another replica may claim the same rows. When the first one wakes, its late update matches no row. Without the guard, a stale claimer could write `attempts`, a new `locked_until` or `failed_at` onto a row now owned by someone else, and could push a row that was in fact delivered towards `MAX_ATTEMPTS` or out of circulation. The guard does **not** prevent a duplicate publish: the stalled replica and the new owner may both have sent the event. At-least-once delivery and the consumer inbox accept that. It only makes sure the row's state is written by the current lease holder. The guard is `locked_by` alone and does not look at `locked_until`: a claim whose lease ended but whose row nobody took still marks it, so a late confirm is recorded. Every update also clears `locked_by` (`markPublished` and `markFailed` clear `locked_until` as well, `recordFailure` keeps it as the retry delay), so a claim changes a row once and a repeated call returns 0. A normal batch never loses its lease, because the lease exceeds the confirm timeout (next paragraph).

**Timing constants (starting values).** Named constants in code, not environment variables:

| Constant | Value | Constraint |
|---|---|---|
| `PUBLISH_CONFIRM_TIMEOUT_MS` | 10 s | A publish that is not confirmed in this time fails that row (the transient failure below). The publisher enforces it, and the relay enforces it again around every publish (see Failures). |
| `CLAIM_LEASE_MS` | 60 s | Must stay **above** `PUBLISH_CONFIRM_TIMEOUT_MS`, so a batch whose confirms all time out still finishes inside its lease. |
| `RELAY_STOP_WAIT_MS` | 5 s | Must stay **below** `SHUTDOWN_TIMEOUT_MS` (10 s in `.env.example`), which also has to cover the HTTP drain. |

The stop wait is shorter than the confirm timeout on purpose: a batch still unconfirmed at shutdown is abandoned and its rows are published again once the lease expires.

**Ordering: none guaranteed.** The relay claims the oldest rows first (`created_at`, then `aggregate_version`) as a best effort. Replicas, retries and the consumer retry queues (`architecture.md` §6.1) can all reorder events of one aggregate, so strict ordering at the relay would not give consumers ordered delivery. Every consumer handler uses guarded state transitions and compares `aggregateVersion` (`architecture.md` §8.2).

**Failures.**

- A **per-row transient failure** (the broker nacks, or a confirm times out while the connection is up): `attempts` increases by one and `locked_until` is set to now plus a backoff, exponential with jitter from an injected random source, starting at 1 s and capped at 5 min.
- After `MAX_ATTEMPTS` (10) such failures the row gets `failed_at` and is skipped for good. A **permanent failure** (the stored payload does not parse as the base `EventEnvelope`) gets `failed_at` at once, because a retry cannot succeed.
- When the **connection itself is down**, rows are not touched. Their leases expire and the loop backs off as a whole, so a broker outage burns no attempts and cannot turn good rows into failed ones.
- **The relay does not trust the publisher to answer.** It races every publish against `PUBLISH_CONFIRM_TIMEOUT_MS` and counts a miss as a `confirm_timeout` row failure. Without it, one publish that never settled would stall the whole batch (nothing is marked until every publish has settled) and the loop would never tick again. An abandoned publish is not cancelled; its late result is ignored.
- **An unexpected error of the publisher** (neither a refusal nor a lost connection) is logged for its row at `error` with the event id, type and error name only (its message could carry event content). The row is left alone, no attempt is charged, and the tick does not fail, so the loop does not back off. The row is claimed again when its lease expires and logs again each time, so it stays visible. It has no terminal state: a person has to look.
- **A refused topology declaration** (`TopologyDeclarationError` from `connect()`) is not a lost connection. It takes the same path as an unexpected error of the publisher: the tick fails, the relay logs it at `error`, touches no row and backs off, so nothing is published until a person fixes the topology or the permissions (ADR-0005 section 3).
- **An error of the store itself** (a claim or an update fails) marks the rows that were confirmed first, then makes the tick fail. The loop logs it and backs off.
- Failures are logged with the event id, type and attempt count, never the payload. Re-queueing a failed row (clear `failed_at`, `attempts` and the lease) is a manual SQL documented in [`docs/runbooks/outbox-failed-rows.md`](../runbooks/outbox-failed-rows.md).
- The numbers are named constants and starting values, not environment variables.

**Loop, batch and stop.**

- The loop runs one tick at a time: connect first (nothing is claimed while the broker cannot be reached), claim, publish, mark, then wait. The wait is 0 after a full batch and the poll interval otherwise. After a failed tick it is a backoff from the same curve as row failures (1 s doubling to 5 min, full jitter, never below 100 ms), which restarts after a good tick. A lost broker is logged once, when it is lost, and once when it is back, and never with the driver's error, whose message can carry the broker URL.
- Every row of a batch is published at once (the batch size, at most 500, bounds the publishes in flight). A row that fails is recorded as soon as it settles; the confirmed rows are marked with one `markPublished` call after all rows have settled. Rows that were confirmed early therefore stay unmarked until the slowest row settles, and a stop or crash in that window publishes them again.
- A store update returns how many rows it changed. Fewer than asked means the claim was lost (its lease expired and another claim took the row), and the relay logs a warning. It says nothing once the store is fenced.
- `stop()` ends the loop's wait, waits for the tick in flight for up to `RELAY_STOP_WAIT_MS`, then fences the store: from then on every store call does nothing and reports zero rows, so a late confirm cannot reach a closing pool. It is safe to call twice, and a stopped relay cannot be started again.
- The relay logs through `@ticketnest/logger`. Lines for one row carry the event's correlation id and the batch's other lines carry one generated for the tick. Only chosen fields are logged (event id, type, attempt count, reason, error name, the names of fields that failed validation), never the payload.

**Unrouted messages.** The publisher declares its exchange with an alternate exchange and a bounded catch-all queue, so an event with no bound queue is kept and the confirm is a real ack ([ADR-0005](0005-rabbitmq-topology.md)). The relay does not use `mandatory`.

**AMQP client.** `amqplib` (2.2.0, pinned exactly; it ships its own types), behind `AmqpEventPublisher implements EventPublisher`, the only class that names it. It is built with the producing domain (`auth`) and publishes every event to that domain's exchange, so the relay never sees an exchange name. One connection per process and one confirm channel. The rules, in short:

- **Connecting is lazy.** The constructor opens nothing. `connect()` (the relay calls it at the start of every tick) opens the connection, declares the topology of ADR-0005 on a channel of its own, closes that channel and opens the confirm channel. It is idempotent while the connection is healthy, and concurrent calls share one attempt. A broker that is down at boot only delays publishing.
- **No background reconnect.** A `close` or `error` event on the connection or the confirm channel ends the session: the publishes in flight are rejected, the dead handles are dropped and the connection is closed. Nothing reconnects until the relay's next `connect()`, so the relay loop owns the only backoff. amqplib's own `recovery` option is not used: while disconnected it makes channel operations wait without bound, so `connect()` would hang instead of throwing. `error` always has a listener, so a driver error is never an uncaught exception. A connection or channel lost while a session is still opening is never installed: that `connect()` rejects with `BrokerUnavailableError` and the next call opens a new connection. Each loss also writes one warn line from the publisher (error name and reply code only), next to the relay's own "broker connection lost" line.
- **Error mapping.** A nack rejects with `PublishNotConfirmedError('nack')` and a missing confirm with `PublishNotConfirmedError('confirm_timeout')`: both charge the row an attempt. A connection that cannot be reached, a refused handshake, a closed connection or channel, and a blocked connection reject with `BrokerUnavailableError`: nothing is charged. amqplib reports a nack as `Error('message nacked')` and a channel closing under a publish as `Error('channel closed')`, both without a code, so the publisher tells them apart by that message (hence the exact pin).
- **A blocked connection counts as unavailable.** While the broker blocks the connection (memory or disk alarm), `connect()` and `publish()` reject with `BrokerUnavailableError` and the publishes in flight are rejected at once, so an alarm burns no attempts. This includes a connection the broker blocked while `connect()` was still opening it. A confirm that still arrives later for a rejected publish is a duplicate delivery, which at-least-once allows.
- **Topology refusals.** A refused declaration (a changed argument is `406 PRECONDITION_FAILED`, a missing permission `403`) makes `connect()` throw `TopologyDeclarationError` with the object name, the reply code and the broker's reply text. It is not fatal and not `BrokerUnavailableError`: the relay's unexpected-error path logs it at `error` on every tick (backing off to the 5 minute cap), touches no row and charges no attempt, while the API keeps accepting writes into the outbox. The broker's reply text to a channel-level refusal never holds the connection URL, so it may be logged; the message of a connection error may, so it never is.
- **The confirm timeout lives in the publisher.** `publish()` starts a timer per publish, rejects with `confirm_timeout` when it runs out, clears it when the publish settles and ignores a confirm that comes later. A timeout leaves the connection alone. The relay's own race stays as a safety net.
- **Half-open links.** The publisher asks for a 3 second heartbeat (`AMQP_HEARTBEAT_SECONDS`, in the URL). amqplib notices a silent link between two and three intervals after it goes quiet, so within 9 seconds, inside the 10 second confirm timeout, and the close ends the publishes in flight as `BrokerUnavailableError`.
- **No backpressure handling.** `publish()` ignores amqplib's "write buffer full" return value, which queues the message anyway. The batch size (at most 500 envelopes of a few KB) bounds the memory in flight.
- **`close()`** is a method of the class, not of `EventPublisher`: the composition root calls it after `relay.stop()`. It is idempotent, rejects the publishes in flight, cancels a `connect()` still opening, closes the channel and then the connection (each bounded by `AMQP_CLOSE_TIMEOUT_MS`), and never throws.
- The body is `JSON.stringify` of the parsed envelope. The writer stored it parsed, so it equals the stored payload.
- A driver error is never copied into an error detail or a log line; logs carry the error name and the reply code only. An unparsable URL throws `InvalidBrokerUrlError` from the constructor, with no cause and no property holding the URL: the `TypeError` of `new URL` keeps the whole input, password included, and a logger would print it.

**Placement and the store interface.** The relay lives in `@ticketnest/messaging`, in a `/relay` sub-path entry (the pattern `@ticketnest/service-runtime/express` already uses), so only code that runs a relay imports `amqplib`. The core entry gains one interface and no dependency:

```ts
interface OutboxRelayStore {
  claimBatch(claimId: string, limit: number, leaseMs: number): Promise<readonly ClaimedOutboxRow[]>;
  markPublished(claimId: string, ids: readonly string[]): Promise<number>;
  recordFailure(claimId: string, id: string, retryAfterMs: number): Promise<number>;
  markFailed(claimId: string, id: string): Promise<number>;
}
```

A claimed row is `{ id, type, payload, attempts }`, with `payload` typed `unknown` because the relay re-checks it against the base `EventEnvelope` before publishing. The update methods return the number of rows they changed (see "Loop, batch and stop"). `OutboxRelay` (the loop and stop) uses `OutboxBatchProcessor` (one tick: claim, publish, mark), and both depend on `OutboxRelayStore`, `EventPublisher`, `IdGenerator`, a random source, a sleep function and the `Logger`. Each service implements the store over its own client.

**Configuration.** A shared `outboxRelayConfigShape` in `packages/config` (spread into a service's `extend({...})`, with `requireBrokerUrlWhenRelayEnabled` called from its `superRefine`) adds `RABBITMQ_URL` (`amqp` or `amqps`, vhost in the path, never logged), `OUTBOX_RELAY_ENABLED` (default `true`, parsed with `z.stringbool()`), `OUTBOX_RELAY_POLL_INTERVAL_MS` (default 1000, 100 to 60000) and `OUTBOX_RELAY_BATCH_SIZE` (default 50, 1 to 500). `RABBITMQ_URL` is required while the relay is enabled, so a deployment that forgot it refuses to start instead of silently never publishing. With `OUTBOX_RELAY_ENABLED=false` the relay is not built and startup logs that it is disabled. The lease, backoff and attempt limits, the confirm timeout and the exchange domain (`auth`) are code, not configuration.

**Readiness and shutdown.** The relay does not affect `/health/ready`, which keeps checking the service's Postgres and Redis. A broker outage delays publishing but the API keeps accepting writes, and the outbox holds them. Because the relay runs in every replica, gating readiness on the broker would take all replicas out of rotation at once. The relay loop catches every error, logs it and keeps polling. On shutdown the relay keeps running while the HTTP server drains, so late requests still get published, then `resources` close in this order: relay (stop claiming, wait for the in-flight batch up to `RELAY_STOP_WAIT_MS`, then give up; unconfirmed rows are published again after the lease expires), the AMQP connection, the Postgres pool, Redis.

### Still open (not decided here)

- Inbox for consumers (§8.2).
- The janitor that deletes published rows: retention, and where it runs (§8.1).
- Consumer-side topology: queues, bindings, retry, the dead-letter queue and what a consumer does with a malformed message (ADR-0005 to be extended).
- Metrics and alerts: outbox lag, failed rows, catch-all queue depth. Until they exist, a failing relay shows only in logs.
- Re-driving the catch-all queue, and an index for the claim query once the table is big enough to need one (none exists today, see "First use").
- A broker that is up, keeps the heartbeat going and still neither confirms nor nacks a publish (a stuck queue, for example) ends the publish as `confirm_timeout`, and each one charges an attempt. The publisher cannot tell it from a slow broker. Ten such failures in a row would end good rows.
- A row that makes the publisher throw an unexpected error has no terminal state and logs once per lease. Whether it should end after some count is not decided.

## Alternatives considered

| Option | Why not |
|---|---|
| CDC with Debezium | Heavy infrastructure (a connector process and logical replication) for a solo project. |
| Claim with `FOR UPDATE SKIP LOCKED` held in one transaction across the publish | A broker call inside a transaction, a connection and row locks held while the broker answers, and Prisma's interactive-transaction timeout to work around. |
| Lease column claimed with `findMany` plus a guarded `updateMany` (no raw SQL) | No `SKIP LOCKED`, so replicas race for the same candidates and the loser wastes a query on every poll. |
| Strict per-aggregate ordering at the relay | A harder claim query, and one poison row blocks its aggregate. Consumer retry queues reorder anyway, so it would not give ordered delivery. |
| Retry forever with no terminal state, or a dead-letter table | The first never separates a broken row from a slow one. The second adds a table and a re-drive path a demo does not need yet. |
| `amqp-connection-manager` or `rabbitmq-client` | The first buffers publishes in memory while disconnected, which fights the outbox. The second is less common. Owning one small reconnect class is acceptable. |
| A separate `packages/outbox-relay`, or the relay in the core entry of `messaging` | The first contradicts `architecture.md` §8.3 for little isolation gain, since every publishing service installs it. The second makes code that only writes events load `amqplib`. |
| Broker in `/health/ready` | A broker outage would take every replica out of rotation although requests still only write outbox rows. |

## Consequences

- A producer cannot lose an event on a crash or publish one for a rolled-back change.
- Delivery stays at-least-once, so every consumer must tolerate duplicates. The relay also gives no ordering, so consumers must compare `aggregateVersion`.
- Every producing service carries an `outbox` table, an `OutboxStore` and an `OutboxRelayStore` implementation. The relay needs a migration that adds `locked_until`, `locked_by` and `failed_at`.
- The claim is short and takes no long locks, but a stalled replica can cause one duplicate publish. The `claimId` guard keeps the row's state correct in that case.
- A row that reaches `failed_at` waits for a person to re-queue it. Nothing alerts on it until metrics exist.
- A broker outage degrades publishing only. The API keeps serving writes and the outbox grows.
- A publish that never answers cannot stall the relay: the relay's own deadline fails the row after `PUBLISH_CONFIRM_TIMEOUT_MS`, at the price of a second timer per row.
- A row that makes the publisher throw an unexpected error is retried after every lease and logs an error each time, until a person fixes the cause. It never slows the other rows.
- After a connection loss, the rows of the interrupted batch stay leased until `CLAIM_LEASE_MS` (60 s) passes, because the relay does not touch rows when the connection itself is down. Publishing of those rows resumes up to a minute after the broker is back, and any of them the broker had already confirmed are published again.
- The writer only guards against undeclared fields because the schemas strip them. Its types refuse a schema whose `type` is not a literal or whose `data` is `unknown` (the base `EventEnvelope`), but they cannot see whether a concrete schema is loose. Each event therefore needs a test that its stored payload has exactly the expected keys.

## Follow-ups

- Done: migration `add_outbox_relay_columns` (`locked_until`, `locked_by`, `failed_at`), with no new index.
- `OutboxRelay`, `OutboxBatchProcessor` and the `OutboxRelayStore` interface are built in `packages/messaging` and tested with fakes (a stale `claimId`, a permanent failure, a publish that never settles, a late confirm after stop). `PrismaOutboxRelayRepository` is built in auth-service. One contract suite (`describeOutboxRelayStoreContract`, exported from `@ticketnest/messaging/testing`) runs against both the in-memory fake and the repository on Postgres, so the fake cannot drift from the SQL. Postgres-only tests cover the order of rows created at the same instant, a row locked by an open transaction being skipped, two concurrent claims, the database clock for the lease, retry delay, `published_at` and `failed_at`, and marking 500 ids in one call. `AmqpEventPublisher` is built in `packages/messaging` (`/relay`) with unit tests over a fake connection, integration tests against a RabbitMQ container (topology, delivery and properties, a full batch of 500, a refused declaration, wrong credentials, the vhost in the URL, `close()`), and outage tests against a container of their own (the broker closing its connections, a deleted exchange, a memory alarm, a silent link behind a proxy, and recovery after each). Done: `outboxRelayConfigShape` and `requireBrokerUrlWhenRelayEnabled` in `packages/config`, and auth-service's wiring (`composeOutboxRelay`, `server.ts`), with an end-to-end integration test (register, outbox row, relay, RabbitMQ container: routed delivery, the catch-all queue, a broker that is down, and shutdown order). Not enforced: `SHUTDOWN_TIMEOUT_MS` must cover the HTTP drain, the relay's 5 s stop wait and the AMQP closes (up to 4 s); the schema allows values as low as 1 s.
- Done: the runbook for failed rows, [`docs/runbooks/outbox-failed-rows.md`](../runbooks/outbox-failed-rows.md).
- Done for auth-service: the variables are in its `.env.example` and `CLAUDE.md` describes the wiring. Each further publishing service repeats both.
