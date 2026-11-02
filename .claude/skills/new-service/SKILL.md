---
name: new-service
description: Scaffold a new TicketNest backend service (catalog, booking, payment, notification) from the services/auth-service skeleton, so every service starts identical. Use when turning a placeholder under services/ into a real Express service, or when asked to "add/bootstrap/scaffold a service".
argument-hint: <service-folder e.g. catalog-service>
---

# New service from the auth-service template

`services/auth-service` is the template. This skill copies it, renames it, and verifies the copy.
Do not invent a different structure: the point is that every service looks the same.

Target: `$ARGUMENTS` (a folder under `services/` such as `catalog-service`). If it is missing, ask.

## 0. Decide first (before copying)

Check these facts; do not assume them.

1. The folder exists and holds only the placeholder `src/index.ts` (`ls -a services/<name> services/<name>/src`). If it already has real code, stop and ask.
2. **Dependencies.** The template wires Postgres and Redis. Drop what the service does not own:
   - `api-gateway` has no data (no `pg`, no Postgres check, no `DATABASE_URL`).
   - A service that does not use Redis drops `ioredis`, `redis-check.ts` and `REDIS_URL`.
   - Keep `/health/ready` honest: it checks exactly the dependencies the service really uses.
3. **Port.** Auth uses `4001`. The repo has no port table, so pick the next free port in the 400x range, confirm it with the user, and use the same value in `Dockerfile` (`PORT`, `EXPOSE`) and `.env.example`.
4. **Database names** come from `infra/docker/postgres/init/01-create-databases.sh`: database `<domain>`, role `<domain>_service`, password env `<DOMAIN>_DB_PASSWORD` (`catalog` / `catalog_service`). A service whose domain is not in that script needs the script and `infra/docker/.env.example` extended first (and `pnpm infra:reset` to apply).

Names used below: `<name>` = folder (`catalog-service`), `<domain>` = `catalog`, `<Domain>` = `Catalog`.

## 1. Copy and rename

Copy the tracked files only (never `node_modules`, `dist`, `.turbo`):

```sh
cd services
for file in $(git -C auth-service ls-files .); do
  mkdir -p "<name>/$(dirname "$file")" && cp "auth-service/$file" "<name>/$file"
done
git rm -f <name>/src/index.ts   # the placeholder, if it is still there
```

Then rename inside the copy (read each hit; do not blind-`sed` prose):

| In auth-service                                   | Becomes                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `auth-service`                                    | `<name>` (package name, `SERVICE_NAME`, Dockerfile, test logger, comments)                 |
| `authConfigSchema`                                | `<domain>ConfigSchema`                                                                     |
| `AuthConfig`                                      | `<Domain>Config`                                                                           |
| `4001`                                            | the chosen port                                                                            |
| `auth_service:change-me-auth@localhost:5432/auth` | `<domain>_service:change-me-<domain>@localhost:5432/<domain>`                              |
| `package.json` `description`                      | one line for this service, keep "Skeleton only: health endpoints, no business routes yet." |

Keep `"type": "module"`, scripts (`dev`, `build`, `lint`, `typecheck`, `test`) and `catalog:` / `workspace:*` versions exactly as in the template. Never hard-code a version.

## 2. File checklist

Every item must exist in `services/<name>/` (paths relative to it):

- [ ] `package.json` (scripts `dev`, `build`, `lint`, `typecheck`, `test`; deps and devDeps as in the template, minus dropped ones)
- [ ] `tsconfig.json` (extends `@ticketnest/tsconfig/node.json`, `paths: { "@/*": ["./src/*"] }`, `include: ["src", "test", "prisma.config.ts", "vitest.config.ts"]`; drop `prisma.config.ts` when the service has no Prisma)
- [ ] `vitest.config.ts` (the `@/` alias plus a `unit` project over `test/unit/**`; keep the `integration` project and `test/support/integration-global-setup.ts` only when the service has a database)
- [ ] `eslint.config.mjs` (`export default node` from `@ticketnest/eslint-config`)
- [ ] `Dockerfile` (filter name, `PORT`, `EXPOSE`, bundle path all renamed)
- [ ] `.env.example` (names and local placeholders only, matching `infra/docker/.env.example`)
- [ ] `src/config.ts` (`SERVICE_NAME`, `<domain>ConfigSchema = baseConfigSchema.extend({...})`)
- [ ] `src/app.ts` (`createApp(dependencies)`: no sockets, no clients; feature routers arrive via `routers`)
- [ ] `src/server.ts` (composition root: the only file that names `Pool` / `Redis`; `loadConfig` first)
- [ ] `src/shutdown.ts`
- [ ] `src/health/` (`dependency-check.ts`, `health.router.ts`, plus one `*-check.ts` per real dependency)
- [ ] `src/http/` (`request-id.middleware.ts`, `request-logger.middleware.ts`)
- [ ] `test/support/create-test-app.ts`
- [ ] Tests: `test/unit/config.test.ts`, `test/unit/shutdown.test.ts`, `test/unit/health/health.test.ts`, `test/unit/http/app.test.ts`
- [ ] Test layout follows `.claude/rules/testing.md`: the template's `test/` also holds auth-specific tests and helpers (register, repositories, hasher, in-memory fakes). Do not copy those; keep only the files listed above, and run `node scripts/check-test-layout.mjs`.
- [ ] Root `.dockerignore` already covers all services; do not add per-service copies
- [ ] `pnpm-workspace.yaml` `catalog:` has every dependency the copy uses (add a version there, never in the service)

Not part of the skeleton, so do not add them: business routes, Prisma schema or migrations, RabbitMQ topology, outbox/inbox tables, auth/JWT middleware.

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
```

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

## Notes

- The skeleton files (`shutdown.ts`, `health/`, `http/`) will be identical in every service. `CLAUDE.md` says to copy the template, so copy. But `.claude/rules/code-quality.md` says logic used by two or more services belongs in `packages/*`. When this skill is run for the second service, tell the user and propose extracting those files into a shared package instead of making a third copy.
- Update this skill whenever `services/auth-service` changes in a way every service should share, so the template and the skill do not drift.
