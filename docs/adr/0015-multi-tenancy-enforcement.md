# ADR-0015: Multi-tenancy enforcement (repository layer vs Postgres RLS)

- **Status:** Proposed (a **[Rec]** decision from [`architecture.md`](../architecture.md) §10 and §14, not yet ratified)
- **Date:** 2026-11-05
- **Deciders:** Project owner
- **Related:** [`architecture.md`](../architecture.md) §6.2, §10, §14 and §15 item 5, [`prd.md`](../prd.md) §2.1, [`permissions.md`](../permissions.md), [`catalog-service.openapi.yaml`](../api/catalog-service.openapi.yaml), ADR-0011, ADR-0013, `.claude/rules/data-access.md`

## Context and problem

Operators (cinemas, bus companies, railways) are tenants. Their rows carry a tenant id, and one operator must never read or change another's data. Other tenants' resources answer `404`, indistinguishable from a missing one (`common.yaml`, ADR-0013). The tenant comes from the verified token, never from a request body (ADR-0013, `.claude/rules/security.md`).

Some data is not tenant-owned: platform-default cancellation policies, movies, stations. Callers come in three kinds: public (anonymous or customer), operator (token has `tenantId`) and admin (no `tenantId`). Catalog is the first service to need this; booking follows (it needs the tenant for `booking:read:tenant`).

`architecture.md` §10 chose a shared repository layer with tests that fail on unscoped queries, and left Postgres row-level security (RLS) to this ADR.

## Decision

### 1. Mechanism: repository scoping, no RLS

- Isolation is enforced in the repository layer. Every query on a tenant-owned model carries the tenant, taken from a scope object built from the verified token.
- Postgres RLS is **not** used for now. With this stack it would need policies written by hand in migration SQL (Prisma's schema cannot express them), `FORCE ROW LEVEL SECURITY` because each service's single role owns its tables and runs its migrations, the tenant set with `set_config` inside every Prisma transaction on the shared `pg` Pool, and explicit bypass policies for public and admin reads.
- RLS stays a documented upgrade path, to add as defence in depth to a service that holds sensitive tenant data. Nothing here prevents it.

### 2. Scopes and how they are derived

One function turns the verified principal into a scope. It reads only the token, never the request body and never the role name (roles are editable bundles of permissions).

| Scope | Who gets it | Effect |
|---|---|---|
| `public` | Anonymous callers and customers | Only published, not-yet-started schedules and public fields. Served by **dedicated repository methods**, not by a staff query that is filtered afterwards. |
| `tenant` | The token has a `tenantId` | Every query is limited to that tenant. An `operatorId` filter sent by the caller is overridden by it. |
| `all` | The token has no `tenantId` and holds the permission the route requires (`x-permissions`) | No tenant filter. An `operatorId` query parameter is an ordinary filter. On create, `operatorId` is required (`operator-required`). |

- The permission guard runs first, so a caller who lacks the route's permission never reaches scope resolution.
- Another tenant's resource, read or written under `tenant` scope, answers `404`.
- A consumer of an event writes under a `tenant` scope built from the event's `tenantId` (decision 6), never under `all`.

### 3. Enforcement

- A shared base repository requires a `TenantScope` argument on every method of a tenant-owned entity (`tenant`, or `all` stated explicitly) and builds the `where` from it. The types force the caller to choose a scope. They cannot stop a method from ignoring it, which is what the test guard below is for.
- Only `src/repositories/` imports the generated Prisma client (`data-access.md`). The base repository and the scope type are shared code in `packages/*`, because catalog and booking both need them (DRY rule). The package that holds them is chosen when catalog is built.
- A **test-only** Prisma query extension wraps the client in the integration project. It fails any query on a tenant-owned model whose `where` has no tenant predicate, unless the scope is `all` or the call is a declared public method. Production code has no extension and no ambient (AsyncLocalStorage) tenant.
- The guard only sees queries that tests run. Every repository method on a tenant-owned model must therefore be exercised by an integration test, and the test asserts the isolation rule: a row of tenant A is not found (`404` at the API) under tenant B's scope.

### 4. Platform rows with no tenant

- `CancellationPolicy` is one table. A platform default is a row whose tenant column (`operatorId` in the spec) is `null`; an operator override carries the operator's id.
- This is the **one** documented exception to "tenant column is `NOT NULL`". The policy repository states it in code: reads under `tenant` and `public` scope return the caller's own rows plus the null rows; creating or superseding a null row needs `all` scope. The test guard recognises the null-row read as allowed on this model only.
- Resolution of the policy for a schedule is one query: the operator's active policy for the vertical, otherwise the platform default (`catalog-service.openapi.yaml`).
- Every other tenant-owned model has a `NOT NULL` tenant column.

### 5. Which catalog data is tenant-owned

- **Tenant-owned** (resources that carry `operatorId` in the spec): `Venue` (and its screens through it), `BusLayout`, `CoachLayout`, `Route`, `Train`, schedules, and operator-scope `CancellationPolicy`.
- **Global, no tenant:** `Movie`. Movies are shared across cinemas, so everyone reads them and only an admin creates, edits and deletes them. `movie:manage` is therefore held by `ADMIN` only. The operator ✓* in `permissions.md` is withdrawn.
- Stations are not decided here (see "Still open").

### 6. Tenant in events

- The envelope `tenantId` is the **only** carrier of the tenant in an event. `data` carries no second copy.
- Each event schema narrows it: a non-null `Id` for events about an operator-owned aggregate (`schedule.published`, `schedule.cancelled`), `null` for platform events (`user.registered`, a platform policy or fee change). A producer that forgets the tenant fails at the schema, before the outbox row is written (ADR-0007).
- A consumer copies the envelope `tenantId` onto its own tenant-owned rows (booking: seat inventory, booking, snapshot) and uses it as its write scope. It never reads a tenant from `data`.
- This refines ADR-0011, which says only that `tenantId` is null for events that belong to no operator.

## Alternatives considered

| Option | Why not |
|---|---|
| Postgres RLS as the enforcer | The Prisma, role and pooling friction listed in decision 1, for a protection that code and tests already give. Kept as an upgrade path. |
| Repository scoping plus RLS | Most secure, but two layers that must agree and two failure modes to debug, for a demo. |
| Prisma extension in production, tenant from AsyncLocalStorage | Hides where scoping happens, does not cover raw SQL or nested relation reads, makes `findUnique` by id a filtered find, and needs a loud escape hatch for `all`. |
| ESLint rule only | Misses dynamically built `where` objects and untested methods. |
| Separate platform and operator policy tables, or a sentinel "platform" tenant row | A second table to merge back into one resource, or a fake tenant that appears in `/v1/operators` and could be impersonated by a token. |
| Operator-owned or operator-created movies | Duplicates one film per operator, or adds an owner column with special edit rules, and contradicts "shared catalogue". |
| Role-name checks in the controller | Contradicts permission-based RBAC and puts a rule in the controller (`code-quality.md`). |
| Public reads as a filtered `all` query | The public path would run with the broadest scope, and one missed filter would expose every tenant's drafts. |

## Still open (not decided here)

- Whether stations are platform-only (`permissions.md` §4 question 2). The assumption there is admin-only; it is unconfirmed.
- Note: the auth-service schema has a single nullable `tenantId` on `User` (set only for operator users, not a foreign key) and no membership table, so a user belongs to at most one tenant, as ADR-0013 and `prd.md` §2.1 say. `architecture.md` §5 no longer lists `TenantMembership`. Supporting one user in several tenants would need a new table and a new ADR.
- How an operator asks for a policy override or a new movie. No request flow exists in any document.
- Tenant status (a suspended operator) and what happens to its live schedules.
- Tenant scoping in booking and payment, which have no spec yet.
- Whether tenant ids in cursors and `ETag`s can leak across tenants.
- The package that holds the base repository and the scope type, and the Prisma column name for the tenant (`operator_id` in the spec, `tenant_id` in `architecture.md`).
- Whether RLS is added later as defence in depth, and for which service.

## Consequences

- A forgotten tenant filter is caught by the test guard, but only when a test runs that query. The isolation test per repository method is therefore mandatory, not optional.
- Scoping is visible in the code (a `TenantScope` argument) and works with Prisma and Testcontainers without database tricks. The cost is discipline in each method.
- A role that holds a staff permission, and whose holder has no `tenantId` in the token, acts across all tenants. A tenant-bound role must always be issued with a `tenantId` (ADR-0013 issues it for operator users). Role editing should keep this in mind.
- Public reads have their own repository methods, so a staff-query bug cannot leak drafts to the public. The cost is more methods to write and test.
- The policy repository carries one hand-documented null-tenant exception that the guard must know about.
- Admin-curated movies mean an operator cannot add a film without an admin.

## Follow-ups

- `permissions.md`: remove the operator ✓* for `movie:manage`; note in §4 question 2 that movies are decided here and stations are not.
- `catalog-service.openapi.yaml`: change the `Movies` tag and `createMovie` text so they say movies are admin-curated and global, and state the three scopes under "Access model".
- `packages/contracts`: when `schedule.published` and `schedule.cancelled` are written, narrow `tenantId` to a non-null `Id`; keep it `null` for `user.registered` (a test per event).
- Update `architecture.md` §10 and §15 item 5 to point at this ADR, and §14 to mark ADR-0015 as written.
- Add the base repository, the `TenantScope` type and the test-only guard when catalog's first repository is built.
