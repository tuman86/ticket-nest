# Code quality

## Layering and SOLID

- Flow is controller -> service -> repository. Never skip a layer or import upward.
- Controller: parse input with Zod, call exactly one service method, map the result. No business rules, no Prisma.
- Service: business rules and transactions. Repository: Prisma only.
- One responsibility per file. If you need "and" to describe it, split it.
- Inject dependencies through the constructor. Never `new` a client or import a singleton inside a service.
- Depend on an interface for every external system: database access (`BookingRepository`), broker (`EventPublisher`), payments (`PaymentGateway`). Only the composition root (`src/main.ts`) names concrete classes.

```ts
// Bad
class BookingService {
  private stripe = new Stripe(process.env.STRIPE_KEY!);
}
// Good
class BookingService {
  constructor(private readonly paymentGateway: PaymentGateway) {}
}
```

## DRY

- Logic needed by two or more services lives in `packages/*`. Never copy it between services.
- Inside one service, tolerate two copies. Extract on the third. No abstraction for a single use.

## Naming

- Functions start with a verb: `calculateRefund`, `findBookingById`.
- Booleans start with `is`/`has`/`can`: `isExpired`, `hasPermission`, `canCancel`.
- No abbreviations: `request`, `response`, `booking`, not `req`, `res`, `bkg`. Allowed: `id`, `url`, `tx`.
- No single-letter variables except `i`/`j` in loops of 5 lines or fewer.

## Checklist

- [ ] No `any`. Use `unknown` and narrow it with Zod.
- [ ] Parse ALL external input with Zod at the boundary: HTTP body/query/params, env vars, broker messages, webhooks.
- [ ] Throw typed errors (`class SeatUnavailableError extends AppError`). One error handler maps them to RFC 9457 problems. Never throw strings or bare `Error`.
- [ ] Log with the shared logger (`@ticketnest/logger`). No `console.log`.
- [ ] Named constants, not magic numbers: `HOLD_TTL_MS = 10 * 60 * 1000`, not `600000`.
- [ ] No secrets in code. Read them from the Zod-validated env module; `.env.example` holds names only.
- [ ] Early returns over nesting deeper than 2 levels.
- [ ] Functions stay under ~40 lines.
