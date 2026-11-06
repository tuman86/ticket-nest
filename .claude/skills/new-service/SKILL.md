---
name: new-service
description: Scaffold a new TicketNest backend service (catalog, booking, payment, notification) from the skeleton files of services/auth-service, so every service starts identical. Use when turning a placeholder under services/ into a real Express service, or when asked to "add/bootstrap/scaffold a service".
argument-hint: <service-folder e.g. catalog-service>
---

# New service from the auth-service skeleton

`services/auth-service` is both the template and a real service. Only part of it is the **skeleton** that every service shares (config, app factory, composition root, shutdown, health checks, request middleware, test helpers and their tests). The rest is auth domain code and the database layer, which a new service must not inherit.

The skeleton is defined by the explicit file list in step 1a. Never copy "everything tracked": that would bring over the register route, password hashing, Prisma and their tests. This skill copies the listed files, strips the auth-specific parts, renames, and verifies. Do not invent a different structure: the point is that every service looks the same.

Target: `$ARGUMENTS` (a folder under `services/` such as `catalog-service`). If it is missing, ask.

## 0. Decide first (before copying)

Check these facts; do not assume them.

1. The folder exists and holds only the placeholder `src/index.ts` (`ls -a services/<name> services/<name>/src`). If it already has real code, stop and ask.
2. **Dependencies.** The skeleton wires Postgres (a `pg` Pool, for the readiness check only) and Redis. Drop what the service does not own:
   - `api-gateway` has no data (no `pg`, no Postgres check, no `DATABASE_URL`).
   - A service that does not use Redis drops `ioredis`, `redis-check.ts` and `REDIS_URL`.
   - Keep `/health/ready` honest: it checks exactly the dependencies the service really uses.
3. **Port.** Auth uses `4001`. The repo has no port table, so pick the next free port in the 400x range, confirm it with the user, and use the same value in `Dockerfile` (`PORT`, `EXPOSE`) and `.env.example`.
4. **Database names** come from `infra/docker/postgres/init/01-create-databases.sh`: database `<domain>`, role `<domain>_service`, password env `<DOMAIN>_DB_PASSWORD` (`catalog` / `catalog_service`). A service whose domain is not in that script needs the script and `infra/docker/.env.example` extended first (and `pnpm infra:reset` to apply).
5. **Scope.** This skill creates the skeleton only. The database layer (Prisma schema, migrations, repositories, integration tests) is a separate, later step: see "After the skeleton".

Names used below: `<name>` = folder (`catalog-service`), `<domain>` = `catalog`, `<Domain>` = `Catalog`.

## 1. Copy the skeleton, strip, rename

### 1a. Copy exactly these files

This list is the definition of the skeleton. Copy nothing else.

```sh
cd services
for file in \
  package.json tsconfig.json vitest.config.ts eslint.config.mjs Dockerfile .env.example \
  src/app.ts src/config.ts src/server.ts \
  src/health/postgres-check.ts src/health/redis-check.ts \
  test/support/create-test-app.ts \
  test/unit/config.test.ts test/unit/http/app.test.ts; do
  mkdir -p "<name>/$(dirname "$file")" && cp "auth-service/$file" "<name>/$file"
done
git rm -f <name>/src/index.ts   # the placeholder, if it is still there
```

### 1b. Strip the auth-specific parts from the copy

The copied files still contain wiring for the auth domain and the database layer. Remove it:

| File               | Remove                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`     | scripts `postinstall` and `db:*`; dependencies `@prisma/adapter-pg`, `@prisma/client`, `@ticketnest/contracts`; devDependencies `prisma`, `@testcontainers/postgresql`, `testcontainers` (add `contracts` when first used) |
| `tsconfig.json`    | `prisma.config.ts` from `include` (result: `["src", "test", "vitest.config.ts"]`)                                                                                                                                          |
| `vitest.config.ts` | the `integration` project and the two timeout constants; keep the `@/` alias and the `unit` project (`extends: true`)                                                                                                      |
| `src/server.ts`    | the `composeAuthRouter` import and the `routers: [...]` line (a skeleton mounts no feature routers)                                                                                                                        |
| `Dockerfile`       | the `RUN node -e "...crypto.argon2..."` line and the two comment lines above it (that check exists for password hashing)                                                                                                   |

Keep the `build` script exactly as in the template, including `--define:import.meta.url=__importMetaUrl` and the `--banner:js`. The generated Prisma client reads `import.meta.url`, and without that define a CJS bundle crashes at startup. It is harmless until the service gets Prisma.

### 1c. Rename inside the copy

Read each hit; do not blind-`sed` prose:

| In auth-service                                                | Becomes                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `auth-service`                                                 | `<name>` (package name, `SERVICE_NAME`, Dockerfile, test logger, comments)                 |
| `authConfigSchema`                                             | `<domain>ConfigSchema`                                                                     |
| `AuthConfig`                                                   | `<Domain>Config`                                                                           |
| `4001`                                                         | the chosen port                                                                            |
| `auth_service` and `auth` in the `DATABASE_URL` format comment | `<domain>_service` and `<domain>`                                                          |
| `auth_service`, `auth` in test fixtures                        | `<domain>_service`, `<domain>` (config and health tests use them as sample values)         |
| `package.json` `description`                                   | one line for this service, keep "Skeleton only: health endpoints, no business routes yet." |

Keep `"type": "module"`, scripts (`dev`, `build`, `lint`, `typecheck`, `test`) and `catalog:` / `workspace:*` versions exactly as in the template. Never hard-code a version.

## 2. File checklist

Every item must exist in `services/<name>/` (paths relative to it), and nothing else:

- [ ] `package.json` (scripts `dev`, `build`, `lint`, `typecheck`, `test`; deps and devDeps as in the template, minus the dropped ones)
- [ ] `tsconfig.json` (extends `@ticketnest/tsconfig/node.json`, `paths: { "@/*": ["./src/*"] }`, `include: ["src", "test", "vitest.config.ts"]`)
- [ ] `vitest.config.ts` (`@/` alias, `unit` project over `test/unit/**`)
- [ ] `eslint.config.mjs` (`export default node` from `@ticketnest/eslint-config`; keep the `src/generated/**` ignore)
- [ ] `Dockerfile` (filter name, `PORT`, `EXPOSE`, bundle path all renamed; no argon2 check)
- [ ] `.env.example` (variable names and non-secret defaults only; a value that holds a password or key is left empty with a comment on its format, as in `security.md`)
- [ ] `src/config.ts` (`SERVICE_NAME`, `<domain>ConfigSchema = baseConfigSchema.extend({...})`)
- [ ] `src/app.ts` (`createApp(dependencies)`: no sockets, no clients; feature routers arrive via `routers`)
- [ ] `src/server.ts` (composition root: the only file that names `Pool` / `Redis`; `loadConfig` first; no routers yet)
- [ ] `src/health/` (one `*-check.ts` per real dependency; the `DependencyCheck` type, the health router, shutdown, the request id and the request logger come from `@ticketnest/service-runtime`, so `package.json` depends on it and `app.ts` and `server.ts` import from it)
- [ ] `test/support/create-test-app.ts`
- [ ] Tests (layout rule: `.claude/rules/testing.md`): `test/unit/config.test.ts`, `test/unit/http/app.test.ts` (the shutdown and health router tests live in `packages/service-runtime/test/`)
- [ ] Root `.dockerignore` already covers all services; do not add per-service copies
- [ ] `pnpm-workspace.yaml` `catalog:` has every dependency the copy uses (add a version there, never in the service)

Not part of the skeleton, so do not add them: business routes and controllers, `@ticketnest/contracts` schemas, password hashing, Prisma schema, migrations, repositories, in-memory fakes, `test/integration/`, RabbitMQ topology, outbox/inbox tables, auth/JWT middleware.

Update the docs that describe the state of the repo:

- [ ] `CLAUDE.md` "State of the project": add `<name>` to the list of real services (and keep "check first" wording)
- [ ] `README.md`: the line listing which services have `dev`/`build`

## 3. Install

```sh
pnpm install     # links the new workspace, updates pnpm-lock.yaml
```

`pnpm-lock.yaml` is generated: never edit it by hand (a hook blocks it). Commit the resulting change.

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

The shutdown, health router, request id and request logger are no longer copied: they come from `@ticketnest/service-runtime`. Confirm the copy did not bring its own versions back: `ls services/<name>/src` must show no `shutdown.ts` and no `http/request-*.middleware.ts`.

Then prove the real thing starts, not just the tests:

1. `pnpm infra:up`, then `cp services/<name>/.env.example services/<name>/.env`.
2. `pnpm --filter @ticketnest/<name> dev` and, in another shell:
   - `curl -i localhost:<port>/health/live` returns `200 {"status":"ok"}`.
   - `curl -i localhost:<port>/health/ready` returns `200` with every check `up`.
   - `curl -i localhost:<port>/nope` returns `404` with `Content-Type: application/problem+json`.
   - The response carries an `X-Request-Id`, and the log line for the request has the same `correlationId`.
3. Stop the infra Postgres (`docker compose -f infra/docker/docker-compose.yml stop postgres`) and confirm `/health/ready` becomes `503` with `postgres: down` and no driver message in the body; start it again.
4. Send `SIGTERM` (Ctrl-C) to the dev process: logs show `shutdown started` then `shutdown finished`, exit code 0.
5. Docker, from the repo root:
   ```sh
   docker build -f services/<name>/Dockerfile -t ticketnest/<name> .
   docker run --rm --network <compose network> -e DATABASE_URL=... -e REDIS_URL=... ticketnest/<name>
   ```
   (hosts on the compose network are `postgres` and `redis`). Check `/health/live`, and that the container runs as a non-root user.
6. The `.env` you created is git-ignored; never commit it.

If step 5 cannot run (no Docker daemon), say so explicitly instead of reporting the Dockerfile as verified.

## 5. Commit

Conventional Commits, lower-case subject, no trailing period, never `--no-verify`:

```
feat(<name>): add express service skeleton with health checks and dockerfile
```

Only commit when the user asks.

## After the skeleton: the database layer

A service that owns data adds its database layer as a **separate change**, not as part of this skill. Use `services/auth-service` as the reference for:

- `prisma/schema.prisma`, `prisma.config.ts`, the first migration and the `db:*` scripts (rules: `.claude/rules/database.md`, and the Prisma and Migrations bullets in `CLAUDE.md`)
- `src/repositories/` (repository interfaces, Prisma implementations, `UnitOfWork`; rules: `.claude/rules/data-access.md`)
- `test/integration/`, `test/support/test-database.ts`, `test/support/integration-global-setup.ts` and the `integration` project in `vitest.config.ts`
- the `postinstall` script, the Prisma dependencies, and `prisma.config.ts` in `tsconfig.json` `include`

The first routes of a service are also a separate change: use the `add-endpoint` skill, one operation of `docs/api/<name>.openapi.yaml` at a time.

## Notes

- The code every service shares at runtime (shutdown, readiness checks, the health router, the request id and request logger middleware) lives in `packages/service-runtime`, per `.claude/rules/code-quality.md` (logic used by two or more services belongs in `packages/*`). Fix it there, never in a service. `services/api-gateway`, the second service, skipped `postgres-check.ts` (no data) and `redis-check.ts` (its limiter fails open, so Redis must not gate readiness), and has no body parser because it streams bodies. Its `app.ts` therefore differs from the template: no `jsonBodyLimit`, and the proxy router arrives through `routers`.
- Schemas several services need (`originListSchema`, `trustProxyHopsSchema`, `shutdownTimeoutMsSchema`, `httpOriginSchema`) come from `@ticketnest/config`; do not copy them from a service's `config.ts`.
- The file list in step 1a is the single definition of the skeleton. When `services/auth-service` gains a file that every service should share, add it to that list (and to the checklist); when a listed file stops being generic, remove it. Update this skill in the same change so the template and the skill do not drift.
