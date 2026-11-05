---
paths:
  - 'services/**'
---

# Tenancy (services)

Reasoning and alternatives: [ADR-0015](../../docs/adr/0015-multi-tenancy-enforcement.md).

## Where the tenant comes from

- Take the tenant only from the verified token (`tenantId` claim). Never from a body, query, path or header.
- One function turns the principal into a scope: `public`, `tenant` (token has `tenantId`) or `all` (no `tenantId` and the route's permission). Never decide by role name.
- A caller's `operatorId` filter is overridden under `tenant` scope. Under `all` it is an ordinary filter.
- An admin creating an operator-owned row must pass `operatorId`, otherwise `operator-required` (422).

## Repositories

- Every repository method on a tenant-owned model takes a `TenantScope` (`tenant` or an explicit `all`) and builds the `where` from it. No method filters by tenant on its own.
- Public reads use dedicated repository methods (published rows, public fields only). Never run an `all` query and filter it in the service.
- Another tenant's row answers `404` (`NotFoundError`), never `403`. It must look the same as a missing row.
- Tenant-owned models have a `NOT NULL` tenant column. The only exception is `CancellationPolicy`: `null` is a platform default, readable by everyone and writable only under `all`.

## Tests

- Every repository method on a tenant-owned model has an integration test: tenant A's row is not found under tenant B's scope.
- The integration project wraps Prisma with the test-only guard. A query on a tenant-owned model with no tenant predicate fails the test unless the scope is `all` or the method is a declared public one.
- The guard sees only queries that tests run, so an untested method is an unguarded method.

## Events

- An event carries the tenant only in the envelope `tenantId`, never in `data`.
- The event schema narrows it: non-null for operator-owned events (`schedule.*`), `null` for platform events (`user.registered`).
- A consumer copies the envelope `tenantId` onto its rows and writes under a `tenant` scope built from it. Never under `all`, and never from `data`.

```ts
// Bad: tenant from the request, no scope
await venueRepository.findMany({ where: { operatorId: request.query.operatorId } });
// Good: scope from the verified token
await venueRepository.findMany(resolveTenantScope(principal), query);
```
