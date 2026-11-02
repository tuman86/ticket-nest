---
paths:
  - 'services/**'
---

# Database migrations (Prisma)

Table ownership and write rules are in `data-access.md`. This file covers schema changes only.

## Creating migrations

- One migration per change. Never bundle unrelated schema changes.
- Name each migration for what it does (`add_booking_hold_expiry`, not `update` or `fix`).
- Generate with `prisma migrate dev --create-only`, then review the SQL before applying it.
- Read the generated SQL for drops, renames (Prisma emits drop + create, which loses data), type changes and `NOT NULL` columns without a default. Hand-edit the SQL when needed.
- Make destructive changes in steps (expand, backfill, contract), and ship each step as its own migration.
- Commit `schema.prisma` and its migration together in the same commit.

## Applied migrations

- Never edit, rename, reorder or delete a migration that has been applied anywhere beyond your own machine. To fix one, add a new migration.
- If a migration was never shared, regenerate it locally with `prisma migrate reset`.

## Environments

- Use `prisma db push` in local dev only, for throwaway experiments. Never use it in CI, staging or production, and never keep its result without a real migration.
- Use `prisma migrate deploy` in CI and production. Never run `migrate dev` or `migrate reset` against a shared database.
- Each service migrates only its own database, using its own role.
