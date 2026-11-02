# Testing layout

Every workspace (service, package, app) keeps tests in a `test/` folder beside `src/`. Never put a test file or a helper in `src/`. `pnpm lint` runs `scripts/check-test-layout.mjs` and fails on a misplaced test.

## Services (`services/*`)

```
test/
  unit/          fast tests, no network or Docker; mirrors src/ (test/unit/auth/register.test.ts)
  integration/   tests that need Docker (Testcontainers Postgres); mirrors src/
  support/       shared helpers: test app builders, in-memory fakes, database setup, global setup
```

- Every test file is plain `*.test.ts`. The folder says whether it is unit or integration, so do not add an `.integration` suffix.
- Vitest runs two projects: `unit` (`test/unit/**`) and `integration` (`test/integration/**`, which starts the throwaway Postgres). `pnpm exec vitest run --project unit` skips Docker.
- Name a test after the file it covers: `src/auth/register.service.ts` -> `test/unit/auth/register.service.test.ts`.

## Packages and apps (`packages/*`, `apps/*`)

- One `test/` folder that mirrors `src/` (`src/express/x.ts` -> `test/express/x.test.ts`). Add `test/support/` only when helpers exist.

## Imports

- Tests import production code with the `@/` alias (`@/auth/register.service`), never `../../../src/...`. The alias is set in two places that must agree: `paths` in the workspace `tsconfig.json` and `resolve.alias` in its `vitest.config.ts`.
- Tests import helpers with relative paths inside `test/` (`../../support/create-test-app`).
- `src/` code keeps relative imports. Only tests use `@/`.

## Writing tests

- Write the failing test first, see it fail for the right reason, then implement.
- Tests use `createApp` with fakes (Supertest). Use in-memory fakes in unit tests and real repositories against Postgres in integration tests.
- Never assert on, log or snapshot a plaintext password, a password hash or a token.
