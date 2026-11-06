---
name: add-endpoint
description: Add one HTTP endpoint to a TicketNest service the way services/auth-service builds them (contract, controller, service, router, wiring, rate limit, outbox event, gateway rule, tests, docs). Use when asked to "add/implement/build an endpoint" or a route that already exists in docs/api/*.openapi.yaml.
argument-hint: <service> <METHOD> <path>
---

# Add an endpoint

`services/auth-service` is the reference for every pattern below. Copy the pattern, not the file: names, tables and policies are auth's own. One endpoint is one operation of an OpenAPI spec, built through every layer, with its tests.

Target: `$ARGUMENTS` = `<service> <METHOD> <path>`, for example `auth-service POST /v1/auth/logout`. If any part is missing, ask.

**Markers.** A line starting `NOT BUILT YET:` means the thing it names does not exist in the repo. Do not invent it, work around it or skip it. Stop, tell the user what the operation needs, and wait.

## 0. Decide first (before writing anything)

Check each fact; do not assume it.

1. **The service is real.** `services/<service>/src/app.ts` and `src/server.ts` exist. If it holds only the placeholder `src/index.ts`, stop, point to the `new-service` skill and offer to run it. Also stop and ask if the operation reads or writes data and the service has no `prisma/schema.prisma` or `src/repositories/` (`new-service` does not build that layer).
2. **The operation is in the spec.** Find `<METHOD> <path>` in `docs/api/<service>.openapi.yaml`. If the file or the operation is missing, stop and ask: the spec comes first, and this skill does not invent operations. (booking-service and payment-service have no spec yet.)
3. **Nothing it needs is unbuilt.** Read the operation's block and the model it touches. Stop if any of these applies:
   - NOT BUILT YET: stop and ask. `x-permissions` other than `self` (the permission/role guard). `CLAUDE.md` says permission and role guards are not built; only `self` and the authentication middleware exist (design: ADR-0025).
   - NOT BUILT YET: stop and ask. `x-recent-login: true` (the `auth_time` age check).
   - NOT BUILT YET: stop and ask. A model a tenant-scoped caller sees only for its own tenant: one with a NOT NULL tenant column, or one of the two nullable exceptions in ADR-0015 (`CancellationPolicy`, and `User`, so `GET /v1/users` with `user:read:tenant` stops here). It needs `TenantScope` and the tenant base repository from `.claude/rules/tenancy.md`. No repository takes a scope yet.
   - NOT BUILT YET: no reference list endpoint; propose the cursor-pagination pattern from common.yaml (Limit, Cursor, Page) to the user, and once approved add it to this skill. Applies to an operation with `Limit`/`Cursor` parameters or a `Page` response.
4. **Classify the operation**, because it decides which branches of step 4 apply:
   - Public (`security: []`), optional (`security: [{}, {bearerAuth: []}]`) or protected (a bearer token)?
   - Does it verify a secret the caller sends (a password, a token)? Does it answer 204 with no body?
   - Does it write (more than one step), or only read?
   - Does the response carry tokens or personal data?
   - Does it create a resource (201)?
   - Does another service need to hear about it (an event)?
   - Is the path prefix new to the gateway?

Say the classification to the user in one short paragraph before step 1.

## 1. Contract

In `packages/contracts/src/<area>/`:

- The request body is a `z.strictObject`, so unknown fields, `role` and `tenantId` are rejected (`security.md`). Reuse the shared pieces (`Email`, `Password`, `Id`, `Timestamp`, `Page`) and do not copy them.
- The response schema is a plain `z.object`: parsing through it drops any field it does not list, so a hash cannot be serialized.
- Export it from the area's `index.ts`, and add `packages/contracts/test/<area>/` tests: a valid value, each bound at its limit and one past it, and an unknown field.
- A new area needs an entry in the `exports` map of `packages/contracts/package.json`. A 204 has no response schema.
- A new event also needs its schema in `packages/contracts/src/events/` (see the event branch).
- The OpenAPI and the Zod schemas are hand-maintained. If they disagree, change both in this step.

## 2. Spec conformance (do this before coding, and again before step 8)

Nothing in a service checks an endpoint against its spec, so do it by hand. From the operation block write down:

- every status code it declares, and the problem `type` of each;
- every response header (`Location`, `Cache-Control`, `ETag`, `Retry-After`, `RateLimit-*`);
- the `security` block, the request schema and the parameters.

Map each item to a test or to code. Anything the spec declares that the code does not do is reported to the user and asked about; never skip it silently. Known example: the spec lists an `ETag` on `GET /v1/users/me` and the service sets none.

Also write down what the code must decide that the spec omits (for example the status for a wrong current password). When the code needs behaviour the spec omits, ask the user and amend the spec in the same change. `self` in `x-permissions` means the user id comes from the principal, never from the path.

## 3. The layers

Flow is controller, service, repository (`.claude/rules/code-quality.md`). Every function gets TSDoc with `@param`, `@returns` and `@throws`.

1. **Controller** `<name>.controller.ts`: `createXHandler(service): RequestHandler`. Parse with `safeParse` and throw `fromZodError(error, 'body' | 'query' | 'path')`, make exactly one service call, map the result. No business rule and no Prisma. Express 5 forwards a thrown error to the error handler.
2. **Service** `<name>.service.ts`: a `...Dependencies` interface injected through the constructor, every external system behind an interface. It owns the rules and throws typed `AppError` subclasses (a domain error gets a `code`). It logs ids only: never an email on a failure path, a token, a hash or a password.
3. **Repository**: a new write goes through the entity's repository, and the method takes the transaction client (`data-access.md`). Only `src/repositories/` imports Prisma. A schema change is its own migration (`database.md`). Before adding a repository method, check the interface and both implementations (Prisma and in-memory) for one that exists.
4. Put the files beside their neighbours (`src/auth/`, `src/users/`, or a new area folder).

## 4. Branches (apply only those step 0 selected)

**Public endpoint.** Every public auth endpoint is rate limited (`security.md`).

- Constants in `src/rate-limit/rate-limit-constants.ts`; the policy in `rate-limit-policies.ts`; a new scope in `RateLimitScope`, read by `rate-limit-identifiers.ts` (a new scope is HMAC-hashed unless added to `PLAINTEXT_SCOPES`).
- Decide `failureMode` per policy and say why: register and login fail closed (a 503 with `Retry-After`), refresh and logout fail open.
- Add the limiter to the limiter set of the router that mounts it (`AuthRateLimiters` is the auth router's; the users router gets its own), and mount it before the handler.
- Tests go in `test/unit/auth/auth.router.test.ts`: the IP limit, each account limit, and both outage behaviours.
- Another service without `packages/rate-limit` wired in needs that wiring first. Ask before adding it.

**Protected endpoint.** The router takes the shared `authenticate` middleware as a dependency. The controller reads the caller only through `getAuthenticatedPrincipal(response)` and passes ids to the service. Re-read the user from the database; take role and tenant from the database, not from the token. A missing or non-`ACTIVE` user gets the same 401 as an invalid token.

**Protected endpoint that verifies a secret** (a current password). Rate limit it too: scope `USER_SCOPE`, read from `getAuthenticatedPrincipal(response)` inside `readIdentifiers(request, response)`; mount `authenticate`, then the limiter, then the handler.

**Optional-auth endpoint.** Use `createOptionalAuthenticateMiddleware` and `findAuthenticatedPrincipal` (`undefined` means anonymous); a token that is sent must be valid.

**Multi-step write.** Open one transaction with the injected `UnitOfWork`, pass `tx` to every repository call, do the slow work (hashing, signing) before it opens, and make no network call inside it. Settle races with a database constraint or a conditional update, not check-then-write.

**Event.** Write the outbox row in the same transaction through a recorder built on `OutboxWriter` (`packages/messaging`). Build the payload from named fields, never by spreading a record. Add a test that the stored payload has exactly the expected keys and none of the personal data, and one that a failed outbox write rolls the change back. Never call the broker from a service. The `tenantId` goes only in the envelope (`tenancy.md`).

**Tokens or personal data in the response.** Set `Cache-Control: no-store`, and for tokens re-parse the result through the response schema.

**Creates a resource.** Answer 201 with a `Location` header.

## 5. Wire it

- Add the service to the router's dependencies interface and register the route.
- Build it in the composition root (`compose-*-router.ts`). It is the only place that names concrete repositories and clients. A dependency it builds privately (the hasher, `RateLimitService`) is hoisted when a second router needs it.
- Update the test helpers that build the router, or they stop compiling: `grep -rl "createXRouter" test/support` for the router you changed, and add a stub for the new service.

## 6. Gateway

Only for a route a client calls through `services/api-gateway`:

- **New path prefix:** one entry in `src/routes/route-table.ts`, and the service's origin in the gateway config and a breaker in `server.ts` if the service is new to it.
- **Public or optional route:** an entry in `src/routes/access-rules.ts`, written as in the spec. The default is `required`, so a protected route needs none. `test/unit/routes/access-rules.test.ts` compares the list with the spec; its counts of public and optional operations come from the spec and change only when the spec gains operations. `readOpenApiOperations` (`test/support/`) reads only the `auth` and `catalog` specs: extend it for a new one.
- A public operation that is not built goes in `UNBUILT_PUBLIC_AUTH_OPERATIONS` until it has a policy and a middleware.
- Add a gateway test only if behaviour changed beyond the table.

## 7. Tests (test first)

Write the failing test, watch it fail for the right reason, then implement (`.claude/rules/testing.md`). Tests live in `test/`, import production code as `@/...`, and never assert on a plaintext password, a hash or a token.

- **Unit** (`test/unit/<area>/`), through `createApp` with Supertest and in-memory fakes:
  - the success status, the body and the headers;
  - an invalid body (422), unparseable JSON (400), an unknown field, an oversized body (413) and a wrong method (404);
  - each typed error and its problem `type`;
  - an unexpected error becomes a generic 500 with no detail;
  - nothing secret in the body, the headers or the log lines;
  - the generic error is identical for every failure when the endpoint must not reveal why.
- **Integration** (`test/integration/<area>/`, real Postgres): only what needs the database: the stored row, the unique index or conditional update under concurrency, transaction rollback, and data read at request time.
- A signed-in caller in a test: `addUser`, `loginNewUser` or `mintAccessToken` (`test/support/`). Put a test beside the existing tests of its area (`me.test.ts` sits in `integration/auth/`). A rollback test needs a double that fails the second statement; add one if none exists.
- Prove a guard bites: break the code once, see the test fail, then restore it.

## 8. Verify

From the repo root, on Node 24. All must pass before reporting done.

```sh
pnpm --filter @ticketnest/<service> typecheck
pnpm --filter @ticketnest/<service> lint
pnpm --filter @ticketnest/<service> test            # unit and integration (needs Docker)
pnpm --filter @ticketnest/api-gateway test          # when step 6 changed anything
pnpm --filter @ticketnest/contracts test
pnpm lint && pnpm format:check                      # lint includes the test-layout check
```

Re-run the step 2 checklist against the finished code. Then prove the real thing:

1. `pnpm infra:up` (needs `infra/docker/.env`), `db:migrate:deploy` for a service with a database, and the service's `.env` from `.env.example` with its empty secrets filled (auth-service: `JWT_PRIVATE_KEY`, `RATE_LIMIT_KEY_PEPPER`, and `RABBITMQ_URL` or `OUTBOX_RELAY_ENABLED=false`). A protected route needs a token: register and log in first.
2. `pnpm --filter @ticketnest/<service> dev`, and with `curl -i`:
   - the success case, with the status and headers the spec declares;
   - one validation failure, answered `application/problem+json` with an `X-Request-Id`;
   - for a rate-limited route, a 429 on the request after the limit, with `Retry-After`.
3. For a gateway route, start the gateway too and send the same success request through it.
4. Stop the dev processes. Never commit a `.env`.

If Docker or the infra cannot run, say so explicitly instead of reporting the endpoint as verified.

## 9. Docs and commit

- Update the feature's bullet in `CLAUDE.md` (or add one), the route list in "State of the project", and the Rate limiting bullet when a policy was added. Update the ADR (ADR-0013 for auth rate limits) or runbook the endpoint touches, and the OpenAPI if step 2 found drift the user chose to fix in the spec.
- Show the diff summary and suggest a Conventional Commit: `feat(<service>): add <METHOD> <path>` (lower-case subject, no trailing period).
- Commit only when the user asks. Never use `--no-verify`.

## Notes

- Shared behaviour lives in `packages/*`; if a second service needs something auth-service built privately, extract it there on the third use (`code-quality.md`) rather than copying it.
- When the permission/role guard, `x-recent-login` or `TenantScope` get built, or the pagination pattern is approved, replace the matching `NOT BUILT YET` marker (grep for that text) with real steps, in the same change.
- When a step here stops matching `services/auth-service`, update this skill in the same change so the template and the skill do not drift.
