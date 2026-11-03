# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## State of the project

TicketNest is a demo booking platform for movies, buses and trains, designed as microservices. Right now the repo is **design docs plus an empty scaffold**: every app and the services other than `auth-service` contain only a placeholder `src/index.ts`. The real code is `packages/contracts`, `packages/config`, `packages/logger`, `packages/errors` and the `services/auth-service` skeleton (health endpoints, the Prisma schema with its first migration, the user, role and refresh-token repositories, and two business routes: `POST /v1/auth/register` and `POST /v1/auth/login`). Do not assume a service, Dockerfile, database or broker exists; check first.

The source of truth for what to build is in `docs/`:

- `docs/prd.md`: requirements. Items marked **[Assumption]** (and listed in section 14) were never confirmed by the owner.
- `docs/architecture.md`: service boundaries, data ownership, the booking saga, outbox/inbox, idempotency, C4 diagrams, and the proposed ADR list (section 14). Decisions marked **[Rec]** are recommended defaults, not ratified.
- `docs/api/`: OpenAPI 3.1 for `auth-service` and `catalog-service`; `common.yaml` holds the shared error/pagination/header components both specs `$ref`.

## Commands

Requires **Node 24** (`.nvmrc`) and pnpm 12 (pinned by `packageManager`; `corepack enable`). `devEngines.runtime` makes pnpm refuse to run on any other Node (`ERR_PNPM_BAD_RUNTIME_VERSION`), and `npm`/`npx` run inside the repo are blocked too. Do not bypass it with `--runtime-on-fail`; switch Node (`fnm use`) instead.

```sh
pnpm install
pnpm lint                 # turbo: eslint in every workspace, then the test-layout check
pnpm typecheck            # turbo: tsc --noEmit in every workspace
pnpm test                 # turbo: vitest in every workspace (auth-service integration tests need Docker)
pnpm format:check         # prettier --check . (pnpm format to write)
pnpm build                # currently a no-op: no workspace defines a build script
```

Single workspace / single test:

```sh
pnpm --filter @ticketnest/contracts test
pnpm --filter @ticketnest/contracts exec vitest run test/contracts.test.ts -t "Money"
```

Local infrastructure (Docker Compose in `infra/docker/`: Postgres 17, Redis 8, RabbitMQ 4 with the management UI):

```sh
cp infra/docker/.env.example infra/docker/.env   # once; .env is git-ignored
pnpm infra:up      # start and wait until all three are healthy
pnpm infra:down    # stop; data volumes are kept
pnpm infra:reset   # DELETES all local data (volumes), then starts fresh
```

- Postgres has one database and one login role per service (`auth`/`auth_service`, `catalog`, `booking`, `payment`, `notification`). The init script runs only on an empty volume, so changing it or a DB password needs `pnpm infra:reset`.
- Host ports bind to `127.0.0.1` and come from `.env` (`*_HOST_PORT`); change one if it clashes with a local install. RabbitMQ UI: `http://localhost:15672`.
- The stack defines no exchanges or queues; the RabbitMQ topology belongs to service code (ADR-0005).

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
- **Shared packages are just-in-time:** `@ticketnest/contracts` exports TypeScript source (`./src/*.ts`), with no build step. Consumers must transpile it (Next `transpilePackages`; services bundle them with esbuild). TS resolution is `Bundler`, `noEmit` everywhere, so there are no `.js` import extensions.
- **Env config:** every service validates its environment with `loadConfig(schema)` from `@ticketnest/config` as the first line of `src/main.ts`. The schema is `baseConfigSchema.extend({...})` (base: `NODE_ENV`, `PORT`, `LOG_LEVEL`). It throws `ConfigError` listing every bad variable, never their values; empty strings count as unset.
- **Logging:** services log through `createLogger({ serviceName, level, nodeEnvironment })` from `@ticketnest/logger`, built from the validated config (pino JSON, pretty only when `NODE_ENV=development`). Wrap each request or broker message in `runWithCorrelationId(id, work)` (id from the `X-Request-Id` header or the event's `correlationId`) and every line gets `correlationId`. Passwords, tokens, OTPs, secrets and `authorization`/`cookie` headers are redacted at the top level and one level down only, so never log objects nested deeper that may hold them.
- **Errors:** throw subclasses of `AppError` from `@ticketnest/errors` (`NotFoundError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`, `BadRequestError`); domain errors subclass these with a `code` (`SeatUnavailableError extends ConflictError`). Convert a failed Zod parse with `fromZodError(error, 'body' | 'query' | 'path')`. In Express 5 mount `handleUnmatchedRoute` then `createErrorHandler({ logger, getCorrelationId, isDebugInfoExposed })` from `@ticketnest/errors/express` last. It answers RFC 9457 `application/problem+json`; anything that is not an `AppError` becomes a generic 500, and 500s never carry `detail`, message or stack unless `isDebugInfoExposed` (development only). The core entry point has no Express dependency, and `ConfigError` is an `AppError`.
- **Strictness is high and enforced:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and type-aware `strictTypeChecked` ESLint (floating promises are errors). Use `import { type X }` for type-only imports.
- **tsconfig presets** (`@ticketnest/tsconfig`): `node.json` for services, `library.json` for packages, `nextjs.json` for apps. `types` defaults to `[]`, so Node types come only from `node.json`. The ESLint `next` preset and Next TS plugin are deliberately deferred until a Next app is bootstrapped.
- **Prettier ignores `docs/`** on purpose (hand-formatted tables, Mermaid, flow-style YAML). Don't run it over docs.
- **Service skeleton (`services/auth-service` is the template; copy it for the next service):** `src/app.ts` exports `createApp(dependencies)` (middleware, health router, error handler; no sockets, no clients) and `src/server.ts` is the composition root that builds the pg `Pool`, the Redis client and the server. Tests import `createApp` with fakes (Supertest, `test/support/create-test-app.ts`). Feature routers are passed in through `routers`. `/health/live` never touches a dependency; `/health/ready` checks Postgres and Redis (2s timeout each), reports only `up`/`down` and never driver messages, and returns 503 once shutdown starts. SIGTERM/SIGINT stop the listener, let in-flight requests finish, close the pool and Redis, then exit (forced after `SHUTDOWN_TIMEOUT_MS`). A service gets `dev`/`build` scripts only when it becomes real: `dev` is `tsx watch --env-file=.env`, `build` is esbuild into one `dist/server.cjs`.
- **Passwords:** hashed with argon2id through Node's built-in `crypto.argon2` (Node 24.7+), behind the `PasswordHasher` interface in `services/auth-service/src/auth/`. Parameters are named constants at the OWASP minimum and are read back from the stored PHC string on verify. See ADR-0013 and `.claude/rules/security.md`. `POST /v1/auth/register` may answer 409 for a taken email, so it must be rate limited, and that limiter must land before the route is exposed through the gateway. `POST /v1/auth/login` has the same rule (limiter in `feat/auth-rate-limit`, plugged in as middleware in `auth.router.ts`).
- **Login and tokens (auth-service):** `LoginService` (`src/auth/login.service.ts`) answers every failure with one `InvalidCredentialsError` (401) and runs exactly one argon2id verify per attempt (a startup-made dummy hash when there is no usable stored hash). Access tokens are EdDSA JWTs signed by `EdDsaTokenService` behind the `TokenService` interface; refresh tokens are 256 random bits stored as SHA-256. The service needs `JWT_PRIVATE_KEY` (base64 PKCS#8 PEM, Ed25519), `JWT_KEY_ID`, `JWT_ISSUER` and `JWT_AUDIENCE` and refuses to start without them (`.env.example` explains how to generate a local key; tests generate keys at runtime). `permissions[]` is issued empty until the permission catalogue is seeded.
- **Docker image:** build from the repo root, `docker build -f services/auth-service/Dockerfile -t ticketnest/auth-service .`. It bundles the service, runs it on bare Alpine as a non-root user with only the Node binary, and needs `DATABASE_URL` and `REDIS_URL` (on the compose network the hosts are `postgres` and `redis`). The bundle has no pino transport, so pretty logs work only under `pnpm dev`. Install scripts are allowed only for esbuild, prisma and @prisma/engines (`allowBuilds` in `pnpm-workspace.yaml`).
- **Prisma (auth-service):** pinned to the stable 7.10.x line in the catalog (`latest` on npm is an 8.0 RC). The client is generated into `src/generated/prisma` (git-ignored) by the service's `postinstall`; run `pnpm --filter @ticketnest/auth-service db:generate` after editing `prisma/schema.prisma`. The connection URL comes from `DATABASE_URL` (`services/auth-service/.env`) through `prisma.config.ts`. Only `src/repositories/` imports the generated client; `createPrismaClient(pool)` reuses the `pg` Pool and is wired in `src/compose-auth-router.ts`. The generated client reads `import.meta.url`, so the esbuild `build` script defines it from `__filename` for the CJS bundle (without that the bundle crashes at startup).
- **Migrations:** `db:migrate:dev` (local, needs the `CREATEDB` right the init script grants; on an old volume run `ALTER ROLE auth_service CREATEDB` once, or `pnpm infra:reset`), `db:migrate:deploy`, `db:migrate:status`. Create with `pnpm --filter @ticketnest/auth-service exec prisma migrate dev --create-only --name <change>`, review the SQL, then apply. See `.claude/rules/database.md`.
- **Tests live in `test/`, never in `src/`** (rule: `.claude/rules/testing.md`; `pnpm lint` enforces it). Services use `test/unit`, `test/integration` and `test/support`; packages and apps use one `test/` mirroring `src/`. Tests import production code as `@/...` (`paths` in `tsconfig.json` plus `resolve.alias` in `vitest.config.ts`).
- **Integration tests:** the files under `test/integration/` form a second Vitest project that starts a throwaway `postgres:17.11-alpine` through Testcontainers (Docker must be running) and applies the real migration SQL. `pnpm exec vitest run --project unit` skips them.

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
- `.claude/rules/testing.md` (always loaded): where tests live (`test/`), the `@/` alias, and how to write them.
