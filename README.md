# TicketNest

Demo booking platform for movies, buses and trains, built as a microservices app.
Stack: Next.js, Express 5, TypeScript (strict), PostgreSQL + Prisma, Redis, RabbitMQ,
pnpm + Turborepo.

## Prerequisites

- Node 24 LTS (see `.nvmrc`; `engines` is enforced). Use any manager that reads `.nvmrc`,
  e.g. `fnm use` or `nvm use`.
- pnpm 12, pinned by `packageManager`: run `corepack enable` once.

## Commands

```sh
pnpm install
pnpm lint          # eslint in every workspace (via turbo)
pnpm typecheck     # tsc --noEmit in every workspace
pnpm test          # vitest in every workspace
pnpm format        # prettier --write .
pnpm format:check  # prettier --check .
```

`dev` and `build` exist only where a service is real: `auth-service` and `api-gateway` today (see their `.env.example`).
The other apps and services are empty placeholders until each one is implemented.

## Layout

| Path                            | Package                            | Purpose                               |
| ------------------------------- | ---------------------------------- | ------------------------------------- |
| `apps/web`                      | `@ticketnest/web`                  | Customer Next.js app                  |
| `apps/console`                  | `@ticketnest/console`              | Admin and operator Next.js app        |
| `services/api-gateway`          | `@ticketnest/api-gateway`          | Auth verification, routing, limits    |
| `services/auth-service`         | `@ticketnest/auth-service`         | Users, roles, tokens, guest access    |
| `services/catalog-service`      | `@ticketnest/catalog-service`      | Inventory definitions, policy, search |
| `services/booking-service`      | `@ticketnest/booking-service`      | Seat holds, bookings, booking saga    |
| `services/payment-service`      | `@ticketnest/payment-service`      | Stripe payments, refunds              |
| `services/notification-service` | `@ticketnest/notification-service` | Email, SMS, web push, reminders       |
| `packages/tsconfig`             | `@ticketnest/tsconfig`             | Shared TypeScript presets             |
| `packages/eslint-config`        | `@ticketnest/eslint-config`        | Shared ESLint flat config             |
| `packages/contracts`            | `@ticketnest/contracts`            | Zod schemas shared across services    |
| `packages/service-runtime`      | `@ticketnest/service-runtime`      | Shutdown, health, request id and log  |

## Docs

- [`docs/prd.md`](docs/prd.md): product requirements
- [`docs/architecture.md`](docs/architecture.md): services, data ownership, saga, outbox
- [`docs/api/`](docs/api): OpenAPI 3.1 specs (auth, catalog)
