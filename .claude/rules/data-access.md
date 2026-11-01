---
paths:
  - 'services/**'
---

# Data access (services)

## Table ownership

- Every table belongs to exactly one service. Never read, join or write another service's tables or database, not even read-only.
- Need another service's data? Call its API, or consume its events and store the fields you need in your own tables.

## Repositories own all writes

- Every create/update/delete goes through that entity's repository class (`BookingRepository`, in `src/repositories/`).
- Import `PrismaClient` only in `src/repositories/` and the outbox/inbox helpers. Never in controllers, routes, middleware, consumers or services.
- Repository write methods take the transaction client as a parameter.

```ts
// Bad (controller)
await prisma.booking.update({ where: { id }, data: { status: 'CONFIRMED' } });
// Good
await bookingService.confirmBooking(id); // service -> bookingRepository.markConfirmed(id, tx)
```

## Transactions live in the service layer

- A multi-step write is ONE transaction, opened by the service through the injected `UnitOfWork` (an interface that wraps `prisma.$transaction`).
- Pass the transaction client down to every repository call. Never open a second or nested transaction inside a repository.
- No network calls (HTTP, Stripe, broker) inside a transaction.

## Events go through the outbox

- Publish only by writing an outbox row in the same transaction as the state change, using the `packages/messaging` outbox writer.
- Never call the broker (`channel.publish`) from services or controllers, and never after the transaction commits.
- Consumers: insert the inbox row, apply the effect and write outbox events in one transaction. Use guarded transitions (`updateMany({ where: { id, status: 'PENDING_PAYMENT' } })`).

```ts
// Bad: lost if the process dies between the two lines
await bookingRepository.create(data);
await broker.publish('booking.created', payload);

// Good
await unitOfWork.run(async (tx) => {
  const booking = await bookingRepository.create(data, tx);
  await outbox.add(tx, bookingCreated(booking));
});
```
