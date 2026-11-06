---
name: new-service
description: Scaffold a new TicketNest backend service (catalog, booking, payment, notification) from the skeleton of services/auth-service, so every service starts identical. Use when turning a placeholder under services/ into a real Express service, or when asked to "add/bootstrap/scaffold a service".
argument-hint: <service-folder e.g. catalog-service>
---

# New service from the auth-service skeleton

`services/auth-service` is both the template and a real service, and it has grown far past a skeleton: tokens, JWKS, rate limiting, the outbox relay and the database layer are all in it. Only a small part is the **skeleton** every service shares: config, the app factory, the composition root, shutdown and readiness, request middleware, and their tests. A new service must not inherit the rest.

The skeleton is defined by the file lists in step 1. Never copy "everything tracked". Some files are copied and stripped, and some are written by hand from the template's shape, because auth's version is mostly auth domain. Do not invent a different structure: the point is that every service looks the same.

Target: `$ARGUMENTS` (a folder under `services/` such as `catalog-service`). If it is missing, ask.

## 0. Decide first (before copying)

Check these facts; do not assume them.

1. The folder exists and holds only the placeholder `src/index.ts` (`ls -a services/<name> services/<name>/src`). A `package.json`, `tsconfig.json`, `vitest.config.ts` and `eslint.config.mjs` may already be there. If it has real code, stop and ask.
2. **Dependencies.** The skeleton has Postgres (a `pg` Pool, for the readiness check only) and nothing else. Add only what the service owns:
   - `api-gateway` has no data (no `pg`, no Postgres check, no `DATABASE_URL`).
   - Redis: skip it unless the service uses it. If it does, auth-service's `redis-check.ts` has no second user yet, so move it to `packages/service-runtime` (as was done for the Postgres check) instead of copying it.
   - RabbitMQ and the outbox relay: skip them unless the service publishes events. The pattern is `compose-outbox-relay.ts` in auth-service.
   - Keep `/health/ready` honest: it checks exactly the dependencies the service really uses.
3. **Port.** Auth uses `4001`, the gateway `4000`. Look in `services/api-gateway/.env.example` for a port it already reserves for this service (catalog: `4002`), otherwise pick the next free port in the 400x range. Confirm it with the user, and use the same value in `Dockerfile` (`PORT`, `EXPOSE`), `.env.example` and the gateway's `.env.example`.
4. **Database names** come from `infra/docker/postgres/init/01-create-databases.sh`: database `<domain>`, role `<domain>_service`, password env `<DOMAIN>_DB_PASSWORD` (`catalog` / `catalog_service`). A service whose domain is not in that script needs the script and `infra/docker/.env.example` extended first (and `pnpm infra:reset` to apply).
5. **Scope.** This skill creates the skeleton only. The database layer (Prisma schema, migrations, repositories, integration tests) is a separate, later step: see "After the skeleton".

Names used below: `<name>` = folder (`catalog-service`), `<domain>` = `catalog`, `<Domain>` = `Catalog`.

## 1. Build the skeleton

### 1a. Copy and strip these files

```sh
cd services
for file in \
  package.json tsconfig.json vitest.config.ts eslint.config.mjs Dockerfile \
  src/app.ts test/support/create-test-app.ts test/unit/http/app.test.ts; do
  mkdir -p "<name>/$(dirname "$file")" && cp "auth-service/$file" "<name>/$file"
done
git rm -f <name>/src/index.ts   # the placeholder, if it is still there
```

A placeholder's own `tsconfig.json`, `vitest.config.ts` and `eslint.config.mjs` already match; keep them (the vitest config needs a `unit` project over `test/unit/**`, with `extends: true`).

| File                              | Remove or change                                                                                                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                    | scripts `postinstall` and `db:*`; dependencies `@prisma/*`, `@ticketnest/auth-middleware`, `contracts`, `messaging`, `rate-limit`, `cors`, `ioredis`, `jose`; devDependencies `prisma`, `testcontainers`, `@testcontainers/postgresql`, `@types/cors` (add `contracts` when first used) |
| `vitest.config.ts`                | the `integration` project and its timeout constants; keep the `@/` alias and the `unit` project                                                                                                                                                                                         |
| `Dockerfile`                      | the `RUN node -e "...crypto.argon2..."` line and the two comment lines above it                                                                                                                                                                                                         |
| `src/app.ts`                      | CORS: the `cors` import, the `corsOrigins` field and its use. The gateway decides CORS alone and strips `Access-Control-*` from upstream responses, so a service's CORS is dead config                                                                                                  |
| `test/support/create-test-app.ts` | `corsOrigins: []`                                                                                                                                                                                                                                                                       |
| `test/unit/http/app.test.ts`      | the three CORS tests that need an allowed origin; keep one that proves no CORS header is sent. Rename `auth_service` fixtures                                                                                                                                                           |

Keep the `build` script exactly as in the template, including `--define:import.meta.url=__importMetaUrl` and the `--banner:js`. The generated Prisma client reads `import.meta.url`, and without that define a CJS bundle crashes at startup. It is harmless until the service gets Prisma.

### 1b. Write by hand (do not copy; auth's versions are mostly auth domain)

- `src/config.ts`: `SERVICE_NAME` and `<domain>ConfigSchema = baseConfigSchema.extend({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }), JSON_BODY_LIMIT: jsonBodyLimitSchema, SHUTDOWN_TIMEOUT_MS: shutdownTimeoutMsSchema, TRUST_PROXY_HOPS: trustProxyHopsSchema })`, plus `REDIS_URL` only if step 0.2 kept Redis.
- `src/server.ts`: the composition root, the only file that names `Pool`. `loadConfig` first; a pool with an error listener; `createShutdown` with the resources `[postgres]`; `createApp` with `readinessChecks: [createPostgresCheck(pool)]` and no routers; `app.listen` with an error handler; SIGTERM and SIGINT.
- `.env.example`: names and non-secret defaults only. A value that holds a password or key stays empty, with a comment on its format (`security.md`).
- `test/unit/config.test.ts`: the defaults, the required and rejected `DATABASE_URL`, `TRUST_PROXY_HOPS` bounds, the `JSON_BODY_LIMIT` wiring, and no secret value in a `ConfigError`.

### 1c. Rename inside the copy

Read each hit; do not blind-`sed` prose:

| In auth-service                                                | Becomes                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `auth-service`                                                 | `<name>` (package name, `SERVICE_NAME`, Dockerfile, test logger, comments)                 |
| `4001`                                                         | the chosen port                                                                            |
| `auth_service` and `auth` in the `DATABASE_URL` format comment | `<domain>_service` and `<domain>`                                                          |
| `package.json` `description`                                   | one line for this service, keep "Skeleton only: health endpoints, no business routes yet." |

Keep `"type": "module"`, scripts (`dev`, `build`, `lint`, `typecheck`, `test`) and `catalog:` / `workspace:*` versions exactly as in the template. Never hard-code a version.

## 2. File checklist

Every item must exist in `services/<name>/` (paths relative to it), and nothing else:

- [ ] `package.json` (scripts `dev`, `build`, `lint`, `typecheck`, `test`; dependencies `config`, `errors`, `logger`, `service-runtime`, `express`, `helmet`, `pg`, `zod`)
- [ ] `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs` (`@/` alias, `unit` project; `export default node`)
- [ ] `Dockerfile` (filter name, `PORT`, `EXPOSE`, bundle path all renamed; no argon2 check)
- [ ] `.env.example`, `src/config.ts`, `src/app.ts` (`createApp(dependencies)`: no sockets, no clients, no CORS), `src/server.ts`
- [ ] No `src/health/` and no `shutdown.ts`: the Postgres check, shutdown, the health router, the request id and the request logger all come from `@ticketnest/service-runtime`
- [ ] `test/support/create-test-app.ts`, `test/unit/config.test.ts`, `test/unit/http/app.test.ts` (the layout rule is `.claude/rules/testing.md`)
- [ ] Root `.dockerignore` already covers all services; `pnpm-workspace.yaml` `catalog:` has every dependency the copy uses (add a version there, never in the service)

Not part of the skeleton: routes and controllers, `@ticketnest/contracts` schemas, password hashing, tokens and JWT middleware, rate limiting, Prisma, repositories, `test/integration/`, RabbitMQ and the outbox.

Update the docs and the neighbours that describe the state of the repo:

- [ ] `CLAUDE.md` "State of the project": add `<name>` to the real services (keep the "check first" wording)
- [ ] `README.md`: the line listing which services have `dev`/`build`
- [ ] `services/api-gateway/.env.example`: drop the "placeholder" comment on this service's URL

## 3. Install

`pnpm install` links the new workspace and updates `pnpm-lock.yaml`. Never edit the lockfile by hand (a hook blocks it). Commit the resulting change.

## 4. Verification

Run from the repo root, on Node 24. All must pass before reporting done.

```sh
pnpm --filter @ticketnest/<name> typecheck
pnpm --filter @ticketnest/<name> lint
pnpm --filter @ticketnest/<name> test
pnpm --filter @ticketnest/<name> build          # produces services/<name>/dist/server.cjs
pnpm format:check                               # prettier; do not run it over docs/
node scripts/check-test-layout.mjs              # no test or helper under src/, tests in test/unit
```

Then prove the real thing starts, not just the tests:

1. `pnpm infra:up` (needs `infra/docker/.env`), then `cp services/<name>/.env.example services/<name>/.env` and fill `DATABASE_URL`.
2. `pnpm --filter @ticketnest/<name> dev` and, in another shell:
   - `curl -i localhost:<port>/health/live` returns `200 {"status":"ok"}`.
   - `curl -i localhost:<port>/health/ready` returns `200` with every check `up`.
   - `curl -i localhost:<port>/nope` returns `404` with `Content-Type: application/problem+json`.
   - The response carries an `X-Request-Id`, and the log line for the request has the same `correlationId`.
3. Stop the infra Postgres (`docker compose -f infra/docker/docker-compose.yml stop postgres`) and confirm `/health/ready` becomes `503` with `postgres: down` and no driver message in the body; start it again.
4. Send `SIGTERM` (Ctrl-C) to the dev process: logs show `shutdown started` then `shutdown finished`, exit code 0.
5. Docker, from the repo root: `docker build -f services/<name>/Dockerfile -t ticketnest/<name> .`, then run it on the compose network with `DATABASE_URL` (the host is `postgres`). Check `/health/live`, and that the container runs as a non-root user.
6. The `.env` you created is git-ignored; never commit it.

If step 5 cannot run (no Docker daemon), say so explicitly instead of reporting the Dockerfile as verified.

## 5. Commit

Conventional Commits, lower-case subject, no trailing period, never `--no-verify`: `feat(<name>): add express service skeleton with health checks and dockerfile`. Only commit when the user asks.

## After the skeleton

A service that owns data adds its database layer as a **separate change**. Use `services/auth-service` as the reference for:

- `prisma/schema.prisma`, `prisma.config.ts`, the first migration and the `db:*` scripts (rules: `.claude/rules/database.md`, and the Prisma and Migrations bullets in `CLAUDE.md`)
- `src/repositories/` (repository interfaces, Prisma implementations, `UnitOfWork`; rules: `.claude/rules/data-access.md`)
- `test/integration/`, `test/support/test-database.ts`, `test/support/integration-global-setup.ts` and the `integration` project in `vitest.config.ts`
- the `postinstall` script, the Prisma dependencies, and `prisma.config.ts` in `tsconfig.json` `include`

The first routes of a service are also a separate change: use the `add-endpoint` skill, one operation of `docs/api/<name>.openapi.yaml` at a time.

## Notes

- **Shared runtime pieces live in `packages/service-runtime` and `packages/config`.** Import them, never copy them. `service-runtime` holds `createShutdown`, `DependencyCheck`, `createPostgresCheck`, and from `/express` the health router, `handleRequestId` and `createRequestLogger`. `config` holds `baseConfigSchema` and the shared schemas (`originListSchema`, `httpOriginSchema`, `trustProxyHopsSchema`, `shutdownTimeoutMsSchema`, `jsonBodyLimitSchema`, `refreshReuseGraceMsSchema`, the outbox relay shape). Fix them there, never in a service.
- When a second service needs something auth-service owns privately, extract it to a package first, in its own change, as was done for the Postgres check and the body-limit schema.
- `services/api-gateway` skipped the Postgres check (no data) and the Redis check (its limiter fails open, so Redis must not gate readiness), and has no body parser because it streams bodies. Its `app.ts` therefore differs from the template.
- When `services/auth-service` gains a file that every service should share, add it to the lists in step 1; when a listed file stops being generic, remove it. Update this skill in the same change so the template and the skill do not drift.
