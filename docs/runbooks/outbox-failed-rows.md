# Runbook: failed outbox rows

Applies to every service that runs the outbox relay (today `auth-service`; ADR-0007, ADR-0005). Each service owns its own `outbox` table in its own database, so run every statement below against the database of the service that owns the row (for auth-service: database `auth`, login role `auth_service`). Never run it against another service's database.

A row is **failed** when `failed_at` is set. The relay never claims it again. Nothing alerts on it yet (metrics are still open in ADR-0007), so someone has to look.

## Ground rules

- **Never put a payload in a ticket, chat message or log.** The `payload` column holds the whole event envelope. Select columns by name and never `SELECT *` or `SELECT payload`. A ticket may carry the event id, `type`, `attempts`, the timestamps and the relay's log fields (ids, counts, a reason, an error name), which hold no event content.
- **Re-queue only after the cause is fixed.** Otherwise the row spends its attempts again and fails again.
- **Never delete a failed row.** It is the only record that the event was never sent.

## How a row becomes failed

| Case                                  | `attempts` in the table                | Relay log message (level)                                                      |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| Ten failed publishes of the same row  | 9 (the tenth failure is not counted)   | `event gave up after its last attempt` (error), field `reason`                 |
| Stored payload is not a valid envelope | unchanged, usually 0                   | `stored event is not a valid envelope, it will not be published` (error)       |

`MAX_ATTEMPTS` is 10 and the delay between attempts grows from 1 s to 5 minutes, so a row that is failing for a broker problem needs a long outage or a stuck queue to end here. A broker that is simply down burns no attempts.

## 1. Find the failed rows

```sql
-- Failed rows, oldest failure first. Never add payload here.
SELECT id, type, aggregate_type, aggregate_id, aggregate_version, attempts, created_at, failed_at
FROM outbox
WHERE failed_at IS NOT NULL AND published_at IS NULL
ORDER BY failed_at;
```

To see how big the problem is, and whether it is one incident:

```sql
SELECT type, count(*) AS failed_rows, min(failed_at) AS first_failure, max(failed_at) AS last_failure
FROM outbox
WHERE failed_at IS NOT NULL AND published_at IS NULL
GROUP BY type;
```

Also look at the backlog, which separates "rows failed" from "the relay is not publishing at all":

```sql
SELECT count(*) FILTER (WHERE published_at IS NULL AND failed_at IS NULL) AS waiting,
       min(created_at) FILTER (WHERE published_at IS NULL AND failed_at IS NULL) AS oldest_waiting,
       max(published_at) AS last_published
FROM outbox;
```

A growing `waiting` with an old `last_published` means the relay is down, disabled (`OUTBOX_RELAY_ENABLED=false`) or cannot reach the broker. That is not this runbook: fix the relay or the broker and the rows publish by themselves.

## 2. Find out why

The table keeps no reason. The reason is in the service's logs, in the relay's lines for that row. Search the JSON logs for `eventId` equal to the row `id`. Lines about a publish carry the event's correlation id, which finds the request that created it. The invalid-envelope line cannot: the payload does not parse, so the id of the event is unknown and the line carries the id of its batch. Find that one by `eventId`.

| Log message                                                                                   | Fields                                      | Meaning                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `event publish failed, it will be retried` (warn)                                             | `eventId`, `type`, `attempts`, `reason`, `retryAfterMs` | One earlier failed attempt. Read them for the pattern.     |
| `event gave up after its last attempt` (error)                                                | `eventId`, `type`, `attempts`, `reason`     | The row failed. `reason` is `nack` or `confirm_timeout`.             |
| `stored event is not a valid envelope, it will not be published` (error)                      | `eventId`, `type`, `failedFields`           | The payload does not parse. `failedFields` are names, never values.  |
| `relay tick failed, backing off` (error)                                                      | `err`                                       | The whole tick failed, for example a refused topology declaration.   |
| `broker connection lost, backing off` / `broker connection closed` (warn)                     | `errorName`, `replyCode`                    | The broker was unreachable. No attempts are charged.                 |

What the `reason` usually means:

| Reason               | Likely cause                                                      | What to check                                                                                                  |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `nack`               | The broker refused the message.                                   | Broker alarms (memory, disk) and queue health in the management UI; the broker's own logs.                     |
| `confirm_timeout`    | The broker did not confirm within 10 s while the link stayed up.  | A stuck or leaderless quorum queue, broker load, a network problem. ADR-0007 lists this case as still open.    |
| invalid envelope     | The stored `payload` is not a valid event envelope.               | See "Rows with an invalid envelope" below. Do not re-queue yet.                                                |

A `relay tick failed` line naming `TopologyDeclarationError` means the broker refused the exchange or queue declaration (a changed argument is `406 PRECONDITION_FAILED`, ADR-0005 section 3). Nothing is published until the topology or the permissions are fixed.

## 3. Fix the cause

Before touching any row, confirm the fix with the rows that are not failed:

- The relay is running on at least one replica and the broker is reachable.
- `max(published_at)` from the backlog query above advances, and no new `gave up` lines appear.

## 4. Re-queue

List the event ids to re-queue (from step 1) and run the update in a transaction. The `WHERE` clause only matches rows that are failed and not published, so a published row cannot be sent again by a typing mistake.

```sql
BEGIN;

UPDATE outbox
SET failed_at = NULL,
    attempts = 0,
    locked_by = NULL,
    locked_until = NULL
WHERE id IN ('<event-id>', '<event-id>')
  AND published_at IS NULL
  AND failed_at IS NOT NULL;

-- The command tag must say UPDATE <the number of ids you listed>.
-- If it differs, run ROLLBACK; and find out why. Otherwise:
COMMIT;
```

Why each column:

| Column         | Why it is cleared                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `failed_at`    | The claim skips every row that has it.                                                                                                 |
| `attempts`     | A row left at 9 fails again on its first problem, because the next failure is counted as the tenth.                                    |
| `locked_by`    | The relay already clears it when it fails a row. Clearing it again is harmless and keeps the statement correct if a lease is left.     |
| `locked_until` | Same: a leftover lease would delay the first claim.                                                                                    |

Leave `payload`, `created_at`, `published_at` and the aggregate columns alone. The relay claims the oldest rows first, so a re-queued row goes out ahead of newer ones. That is fine: the relay promises no ordering, and consumers compare `aggregate_version` (ADR-0007).

To re-queue a whole incident instead of a list, replace the `id IN (...)` line with `type = '<type>' AND failed_at >= '<incident start>'`, and run the `SELECT count(*)` of the same condition first to know what to expect.

## 5. Check afterwards

```sql
SELECT id, attempts, published_at, failed_at
FROM outbox
WHERE id IN ('<event-id>', '<event-id>');
```

Within a few poll intervals each row has `published_at` set, `attempts` 0 and `failed_at` null. If one fails again, read its log lines again (step 2) and stop: do not re-queue a row twice without a new fix.

Delivery is at-least-once. A row that failed on `confirm_timeout` may have reached the broker before, so a consumer can receive the event twice. Consumers are designed to dedupe on the event id (the inbox, which is not built yet; ADR-0007), so this is expected. Today nothing consumes `auth.events`. While no consumer queue is bound, a published event sits in the `auth.unrouted` catch-all queue for 7 days (ADR-0005); re-queueing does not change that.

## Rows with an invalid envelope

Retrying cannot work, so do not re-queue these until the stored row is correct. The writer validates every event before it inserts it (`InvalidOutboxEventError`), so an invalid stored payload means the row was changed outside the writer, a migration touched it, or the base `EventEnvelope` changed. Treat it as an incident:

1. Use `failedFields` from the log line to see which fields failed. Do not read the payload into a ticket.
2. Find what changed the data or the schema, and fix that first, or new rows will fail the same way.
3. Whether to repair the row or leave it failed is the project owner's decision. Leaving it failed means consumers never receive that event. If it is repaired, do it through a reviewed script or migration (`.claude/rules/database.md`), not an ad-hoc `UPDATE` of `payload` on a shared database, and then re-queue it with step 4.

## Not covered here

- **A row that makes the publisher throw an unexpected error** has no `failed_at`. The relay leaves it alone, and it logs `publish failed with an unexpected error, the row is left for its lease to expire` each time its lease ends. Fix the cause named by `errorName`; the row publishes by itself afterwards. There is nothing to re-queue.
- **Deleting published rows.** The janitor that does it is not built yet (ADR-0007, "Still open").
- **Alerts and metrics** on failed rows, outbox lag and the catch-all queue depth are not built.
