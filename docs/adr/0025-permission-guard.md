# ADR-0025: Permission catalogue, role administration and the permission guard

- **Status:** Proposed (a **[Rec]** decision from [`architecture.md`](../architecture.md) §14, not yet ratified)
- **Date:** 2026-11-06
- **Deciders:** Project owner
- **Related:** [`permissions.md`](../permissions.md), ADR-0013, [ADR-0015](0015-multi-tenancy-enforcement.md), [`auth-service.openapi.yaml`](../api/auth-service.openapi.yaml), [`catalog-service.openapi.yaml`](../api/catalog-service.openapi.yaml), `.claude/rules/tenancy.md`, `.claude/rules/security.md`

## Context and problem

ADR-0013 chose permission-based RBAC: roles are editable bundles of permissions, copied into the access token as `permissions[]`, and every service verifies them. The pipeline from token to `AuthenticatedPrincipal` is built. Its source is not: login and refresh issue `permissions: []` because the database has no permissions, and no guard, recent-login check or role endpoint exists. ADR-0015 says the permission guard runs before scope resolution but does not define it.

This ADR decides what the catalogue is and where it lives, how roles are administered, and the rules the guard follows, so the guard and the role endpoints can be built in small pull requests without reopening them.

## Decision

### 1. The catalogue

- The source is a typed constant in `packages/contracts`: each key with its description. `docs/permissions.md` is the human-readable list of the same keys.
- auth-service stores it in a `permissions` table (`key` primary key, `description`). `role_permissions` links a role to a key with a foreign key, so the database can never hold an unknown key. A role's permissions are rows of `role_permissions`.
- Migrations are hand-written, reviewed SQL (`database.md`). The first one creates both tables and seeds the catalogue and the default grants (section 3). A later key is a new migration that only adds: `INSERT ... ON CONFLICT DO NOTHING` for the key, plus grants of that **new** key to the default roles it belongs to. A migration never deletes a key and never updates or deletes a grant, so what an admin edited is not reset. A description may be corrected by a later migration, because it is catalogue text, not an admin edit.
- An integration test migrates a fresh database and requires the `permissions` table (keys and descriptions) to equal the constant. A unit test requires the constant's keys to match `permissions.md` and every `x-permissions` key in both OpenAPI specs (keys only; descriptions are compared only with the table, by the integration test above), the way the gateway's access-rules test compares its list with the specs.
- A key therefore changes in five places in one change: the constant, `permissions.md`, the spec's `x-permissions`, an add-only migration, and the tests above. `GET /v1/permissions` answers from the table.

### 2. Roles

- `roles` gets a `tenant_bound` boolean. `OPERATOR` is seeded `true`, the other three `false`. A user whose role is tenant-bound must have a `tenantId`; a user whose role is not must not (`tenant-required`, 422). This replaces the spec's check on the role key `OPERATOR`, which `tenancy.md` forbids and which made a custom tenant-bound role impossible.
- `users.tenant_id` stays nullable: customers, support agents and admins have no tenant. That is the `User` exception in [ADR-0015](0015-multi-tenancy-enforcement.md) (decision 4): a tenant-scoped read never matches a null `tenant_id`.
- `tenantBound` is set when a role is created (default `false`). It cannot change while any user holds the role (`role-in-use`, 409), and not at all on a built-in role (`system-role-immutable`).
- The four built-in roles (`system: true`) cannot be deleted, and their `key` cannot change. Their `name`, `description` and permissions are editable.
- A custom role holding permissions on tenant-owned resources should be tenant-bound. The guard does not check this; the role endpoints may warn.

### 3. The first seed

- All 22 keys of `permissions.md`, including the five whose specs are not written (`booking:read:any`, `booking:read:tenant`, `booking:cancel:any`, `refund:issue`, `refund:approve`). Keys without a consumer are harmless, and adding them later would cost a migration.
- Grants that the PRD matrix confirms go to every role as the matrix shows. Grants marked unconfirmed (**[Assumption]**) are seeded **for `ADMIN` only**. These are withheld until the owner confirms them:
  - `OPERATOR`: `user:read:tenant` (so it cannot list its tenant's users) and `booking:read:tenant`.
  - `SUPPORT_AGENT`: `user:read:any` (so it cannot look up users) and `booking:cancel:any` (so it cannot cancel a booking on a customer's behalf).
  - `CUSTOMER`: none.
  - `ADMIN` keeps all of them, together with `station:manage`, which only `ADMIN` is assumed to hold.
- Confirming a withheld grant is an add-only migration.

### 4. Permissions in the token

- Login and refresh read the user's role permissions from the database and put them in `permissions[]`. A role edit therefore reaches a user at the next token (at most 10 minutes), and a removed permission keeps working until the access token expires. This is ADR-0013's accepted weak point 1.
- A token is bounded by the catalogue: a role holds only catalogue keys, without repeats. With 22 keys the token is a few hundred bytes larger. The verifier's 8 KB header limit would only matter beyond roughly 250 keys, so no extra cap is added now.

### 5. The guard

These rules were decided with the design; the guard pull request implements them.

- **Several keys are any-of.** `x-permissions: ['role:manage', 'user:manage']` is satisfied by holding either key. `self` is not a permission: the route needs authentication, and the handler takes the user id from the principal, never from the path or body.
- **Order of checks.** Authenticate (401), then the permission (403), then recent login (401 `reauthentication-required`). A caller who lacks the permission is never told to sign in again, and never reaches scope resolution (ADR-0015).
- **Recent login.** An operation marked `x-recent-login: true` needs `auth_time` no older than `RECENT_LOGIN_MAX_AGE_MS` (5 minutes), measured on an injected clock. A refresh copies `auth_time`, so only a password login renews it. The error is a 401 with the `reauthentication-required` problem (`common.yaml`).
- **Scope comes from the token's `tenantId` alone** (ADR-0015), never from the role name. A key's suffix can only narrow access, never widen it. A token with a `tenantId` always gets `tenant` scope, even if its role holds an `:any` or unscoped key. A token without a `tenantId` gets `all` scope through an unscoped or `:any` key; through a `:tenant` key it is refused (403), because the key names a tenant and the token has none. A key with the `:own` suffix acts on the caller's own record only.
- **No privilege escalation.**
  - A caller can grant or assign only permissions they hold: a role edit's `permissions`, and the role of a user being created or changed, must be a subset of the caller's own.
  - A caller cannot change their own role.
  - A change must never leave the platform without an active user who can manage users and roles: disabling or demoting the last such user, and removing `user:manage` or `role:manage` from the last role that grants them, are refused. The problem type is named in the pull request that builds it.
- **Platform permissions.** Until decided otherwise (see "Still open"), `user:manage` and `role:manage` are treated as platform-only: a token with a `tenantId` is refused even if a custom role holds them.

## Alternatives considered

| Option | Why not |
|---|---|
| No `permissions` table; keys checked in code against the constant | The database could hold a key the code no longer knows, and there would be nothing for the equality test to compare. |
| The database as the only source, with no constant | Services and the guard would have no typed key list, and the doc, the specs and the seed could drift unseen. |
| Migration SQL generated from the constant by a script | A script to maintain for about 25 rows, and applied migrations may not change, so it would only ever emit additions. Hand-written SQL plus the equality test gives the same safety. |
| Keep the `OPERATOR` key check for `tenantId` | A custom role could never be tenant-bound, so a role with `inventory:create` and no `tenantId` would act on every tenant (ADR-0015). |
| Derive tenant binding from a role's permissions | Editing a role's permissions would silently change whether its users need a `tenantId`. |
| Scope from the key suffix (`:tenant`, `:any`) | Two mechanisms for one question. A token's `tenantId` is verified; a suffix is only a label, and an editable role could carry a wide key. |
| Shorter access tokens instead of a recent-login check | Rejected in ADR-0013. |

## Still open (not decided here)

- Whether `user:read:tenant` and similar keys let a tenant-bound caller manage users of its own tenant, which would make `user:manage` tenant-scopable. The guard treats `user:manage` and `role:manage` as platform-only until this is decided.
- Recent login for `operator:manage`, `schedule:cancel` and `fee:manage` (`permissions.md` §4 question 1).
- The five unconfirmed grants of section 3, and the booking and refund keys' specs.
- The problem type and wording for the "last administrator" refusal.
- Merge-patch, `ETag`, `If-Match` and the 412 answer for role edits, and the cursor-pagination pattern for the list endpoints. Both belong to ADR-0016 (API style), which is not written.
- Email delivery for `POST /v1/users`: the new staff user "receives an email to set a password", and no notification path exists.
- Who owns stations (`permissions.md` §4 question 2, ADR-0015).

## Consequences

- Tokens carry real permissions after the issuing change, and any service can guard its routes with the shared guard. Catalog's staff endpoints do not wait for the role endpoints.
- Granting `ADMIN` the unconfirmed grants means admins can do what the owner has not yet approved for anyone else. That is the safest default while the owner's answers are open.
- The five-place change for a new key is deliberate friction. The two tests catch a missed place.
- Because the guard never widens a tenant-bound token, a mistake in a custom role cannot let an operator act across tenants.
- A removed permission, a demoted user and a disabled user all keep working for up to 10 minutes, as ADR-0013 accepts.

## Follow-ups

Planned as separate pull requests, in this order:

1. The constant in `packages/contracts`, with the drift test.
2. The guard in `packages/auth-middleware`: `requirePermission`, `requireRecentLogin`, the `reauthentication-required` error, `RECENT_LOGIN_MAX_AGE_MS`, and the pure principal-to-scope function. Unit tests only, including a check of the `Recent login` column of `permissions.md` against `x-recent-login` in the specs (left out of the catalogue's drift test because it needs a per-operation rule).
3. auth-service: the migration (`permissions`, `role_permissions`, `roles.tenant_bound`, the seed), the role repository returning permissions, and its integration tests including the equality test.
4. auth-service: login and refresh issue the role's permissions.
5. The cursor-pagination pattern (with ADR-0016).
6. `GET /v1/permissions`, `GET /v1/roles` and `GET /v1/roles/{roleId}`.
7. Role create, edit and delete, with recent login, `ETag` and `If-Match`.
8. User administration, after the tenant-scope base repository (ADR-0015) and an email path exist.

When 2 is built, replace the first two `NOT BUILT YET` markers of `.claude/skills/add-endpoint/SKILL.md`; the tenant marker goes when the base repository lands, and the list marker with 5.
