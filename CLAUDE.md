# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## State of the project

TicketNest is a demo booking platform for movies, buses and trains, designed as microservices. Right now the repo is **design docs plus an empty scaffold**: every app and service under `apps/` and `services/` contains only a placeholder `src/index.ts`. The only real code is `packages/contracts`. Do not assume a service, Dockerfile, database or broker exists; check first.

The source of truth for what to build is in `docs/`:

- `docs/prd.md`: requirements. Items marked **[Assumption]** (and listed in section 14) were never confirmed by the owner.
- `docs/architecture.md`: service boundaries, data ownership, the booking saga, outbox/inbox, idempotency, C4 diagrams, and the proposed ADR list (section 14). Decisions marked **[Rec]** are recommended defaults, not ratified.
- `docs/api/`: OpenAPI 3.1 for `auth-service` and `catalog-service`; `common.yaml` holds the shared error/pagination/header components both specs `$ref`.

## Commands

Requires **Node 24** (`.nvmrc`) and pnpm 12 (pinned by `packageManager`; `corepack enable`). `devEngines.runtime` makes pnpm refuse to run on any other Node (`ERR_PNPM_BAD_RUNTIME_VERSION`), and `npm`/`npx` run inside the repo are blocked too. Do not bypass it with `--runtime-on-fail`; switch Node (`fnm use`) instead.

```sh
pnpm install
pnpm lint                 # turbo: eslint in every workspace
pnpm typecheck            # turbo: tsc --noEmit in every workspace
pnpm test                 # turbo: vitest in every workspace
pnpm format:check         # prettier --check . (pnpm format to write)
pnpm build                # currently a no-op: no workspace defines a build script
```

Single workspace / single test:

```sh
pnpm --filter @ticketnest/contracts test
pnpm --filter @ticketnest/contracts exec vitest run src/contracts.test.ts -t "Money"
```

Docs checks (no script exists; run from a shell on Node 24):

```sh
npx @redocly/cli@1.34.5 lint docs/api/auth-service.openapi.yaml   # also catalog-service
```

Mermaid blocks in `docs/architecture.md` are validated by rendering them with `@mermaid-js/mermaid-cli` (`mmdc`); a literal `;` inside a sequence-diagram message breaks the parser.

## Git hooks and commit messages

Husky is installed by `pnpm install` (the root `prepare` script sets `core.hooksPath` to `.husky/_`).

- `pre-commit` runs lint-staged (`lint-staged.config.mjs`): `eslint --fix` from each file's own workspace (type-aware ESLint needs that cwd), then `prettier --write`. It fixes files and re-stages them; unfixable ESLint errors abort the commit.
- `commit-msg` runs commitlint (`commitlint.config.mjs`, `@commitlint/config-conventional`). Use Conventional Commits: `type(scope): lower-case subject`, no trailing period. Types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test.
- Never bypass with `--no-verify`. In CI, set `HUSKY=0` so `prepare` does not install hooks.

## Monorepo conventions that are not obvious

- **Workspaces:** `apps/*`, `services/*`, `packages/*`, all named `@ticketnest/<folder>`. Shared dependency versions live in the `catalog:` block of `pnpm-workspace.yaml`; reference them as `"catalog:"`, do not hard-code versions in workspace `package.json` files.
- **TypeScript is pinned to `~6.0.3`** because `typescript-eslint` does not support TypeScript 7 yet. Do not bump it until that changes.
- **Shared packages are just-in-time:** `@ticketnest/contracts` exports TypeScript source (`./src/*.ts`), with no build step. Consumers must transpile it (Next `transpilePackages`; bundle with tsup/esbuild for services later). TS resolution is `Bundler`, `noEmit` everywhere, so there are no `.js` import extensions.
- **Strictness is high and enforced:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and type-aware `strictTypeChecked` ESLint (floating promises are errors). Use `import { type X }` for type-only imports.
- **tsconfig presets** (`@ticketnest/tsconfig`): `node.json` for services, `library.json` for packages, `nextjs.json` for apps. `types` defaults to `[]`, so Node types come only from `node.json`. The ESLint `next` preset and Next TS plugin are deliberately deferred until a Next app is bootstrapped.
- **Prettier ignores `docs/`** on purpose (hand-formatted tables, Mermaid, flow-style YAML). Don't run it over docs.
- New services get `dev`/`build` scripts (tsup/tsx) only when they become real; nothing is wired for that yet.
- Prisma: `latest` on npm is currently an 8.0 RC; use the stable 7.10.x line when database work starts.

## Architecture (big picture)

Six services plus two Next.js apps, each service owning a private Postgres database (no cross-service reads or shared tables). Naming: the identity service is **`auth-service`** everywhere (an earlier `identity` name was renamed).

- `api-gateway`: routing, rate limiting, JWT verification. No business rules or data.
- `auth-service`: users, permission-based RBAC (roles are editable bundles of permissions), tokens, guest sessions, email OTP.
- `catalog-service`: operators (tenants), venues/screens, movies, stations/routes/trains, schedules (shows/trips/runs), prices, cancellation policy and fee config, search.
- `booking-service`: seat inventory, Redis holds, bookings, train segment logic, **saga orchestration**, tickets.
- `payment-service`: Stripe PaymentIntents/webhooks/refunds, refund approval queue.
- `notification-service`: email, SMS, web push, DB-backed reminder scheduler.
- `web` (customers) and `console` (admin/operator) call only the gateway.

Cross-cutting rules that span many files:

- **No double-booking, ever.** Redis `SET NX PX` holds (10 min) are a fast pre-filter only. The arbiter is a Postgres unique constraint on `SeatClaim(schedule, seat, segment)`. Trains claim one row per journey segment, so overlap is detected by the constraint. A sweeper (not Redis keyspace events) expires holds.
- **Booking saga is orchestrated inside booking-service**: hold, create booking (sync call to payment for the PaymentIntent), Stripe webhook, `payment.succeeded`, confirm. A payment landing after hold expiry re-claims the seats if free, otherwise triggers a full refund. Booking status and refund status are separate fields; the refund lives in payment.
- **Events:** RabbitMQ topic exchanges per producing domain (`auth.events`, `catalog.events`, `booking.events`, `payment.events`), one quorum queue per consumer, retry queues then DLQ. Every publisher uses a **transactional outbox** (polling relay, `FOR UPDATE SKIP LOCKED`); every consumer uses an **inbox** table and guarded state transitions. Delivery is at-least-once, so handlers must be idempotent.
- **Idempotency layers:** `Idempotency-Key` on client commands, deterministic Stripe keys (`pi:{bookingId}`, `refund:{refundId}`), webhook dedupe on `event.id`, unique dedupe keys for notifications.
- **Snapshots:** booking stores a schedule snapshot and cancellation-policy snapshot at hold time, so later policy edits never change existing bookings and cancelling needs no call to catalog. Events carry the data consumers need (no callbacks).
- **Auth:** asymmetric JWT, 10-minute access tokens with `role`, `permissions[]`, `tenantId`; the gateway and each service both verify. Guests use an anonymous `sid` token for holds. Guest booking lookup uses an email-proof token from auth-service; the **booking** service (which holds the data) checks that the booking reference matches the email.
- **Tenancy:** operator-owned rows carry `tenant_id`; other tenants' resources answer `404`, not `403`.
- **Money and time:** integer minor units (cents, USD), never floats; UTC timestamps with the IANA timezone stored on venues/stations.

API conventions (`docs/api/common.yaml`): `/v1` versioning, RFC 9457 `application/problem+json` errors, cursor pagination returning `{ data, page: { limit, nextCursor, hasMore } }`, `PATCH` as JSON Merge Patch, optional `ETag`/`If-Match`. The Zod schemas in `packages/contracts` mirror these (`Problem`, `Page`, `Money`, `EventEnvelope`) and are hand-maintained, so change the OpenAPI and Zod together.

## Rules

Short, enforceable rules live in `.claude/rules/`:

- `.claude/rules/data-access.md` (scoped to `services/**`): table ownership, repository-only writes, service-layer transactions, outbox publishing.
- `.claude/rules/code-quality.md` (always loaded): layering and DI, DRY, naming, and the code checklist.
