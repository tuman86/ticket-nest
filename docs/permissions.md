# Permission catalogue

**Status:** Draft · **Date:** 2026-11-02
**Related:** [`prd.md`](./prd.md) §2.1 · [`adr/0013-auth-strategy.md`](./adr/0013-auth-strategy.md) · [`api/auth-service.openapi.yaml`](./api/auth-service.openapi.yaml) · [`api/catalog-service.openapi.yaml`](./api/catalog-service.openapi.yaml)

This is the single list of permission keys the platform understands. It is the source for `GET /v1/permissions` and for the auth-service seed data. The PRD's indicative matrix points here for the final list.

Grants marked **[Assumption]** are not in the PRD or any spec and were never confirmed by the owner.

## 1. Key format

- Shape: `resource:action[:scope]`, lower case, matching `^[a-z_]+:[a-z_]+(:[a-z_]+)?$` (`PermissionKey` in the auth spec).
- `scope` narrows who the permission applies to: `own` (the caller's own record), `tenant` (the caller's tenant), `any` (everything). No scope means the action itself is the whole grant.
- `self` is not a permission. It marks operations any authenticated user may perform on their own record, so it never appears in a role.
- Permissions are copied into the access token as `permissions[]` and verified by each service. Changes reach users on their next token (at most 10 minutes).
- A key has to be added here, to `x-permissions` in the owning spec, and to the auth-service seed in the same change.

## 2. Catalogue

**Recent login** marks permissions whose mutating operations require a password login within the last 5 minutes (`x-recent-login: true`, ADR-0013). **Candidate** means the owner has not decided yet.

### 2.1 Defined in an OpenAPI spec

| Key | Allows | Spec | Recent login |
|---|---|---|---|
| `user:manage` | Create staff users; change a user's role, tenant or status | auth | Yes |
| `user:read:any` | List and read any user | auth | |
| `user:read:tenant` | List and read users of the caller's own tenant | auth | |
| `role:manage` | Create, edit and delete roles; list the permission catalogue | auth | Yes |
| `operator:manage` | List, onboard, edit and suspend operators (tenants) | catalog | Candidate |
| `operator:read:own` | Read the caller's own operator record | catalog | |
| `inventory:read` | Read venues, screens, routes and bus and coach layouts | catalog | |
| `inventory:create` | Create venues, screens, routes, layouts and trains | catalog | |
| `inventory:update` | Update the same inventory | catalog | |
| `inventory:delete` | Delete the same inventory | catalog | |
| `schedule:read` | See schedules that are not published | catalog | |
| `schedule:manage` | Create, edit, delete and publish schedules | catalog | |
| `schedule:cancel` | Cancel a show or trip (triggers refunds) | catalog | Candidate |
| `movie:manage` | Create, edit and delete movies | catalog | |
| `station:manage` | Create and edit stations | catalog | |
| `policy:manage` | Publish a new cancellation-policy version | catalog | Yes |
| `fee:manage` | Replace the convenience fee configuration | catalog | Candidate |

### 2.2 Named in the PRD, spec not written yet

| Key | Allows | Recent login |
|---|---|---|
| `booking:read:any` | View any booking | |
| `booking:read:tenant` | View bookings for the caller's own tenant **[Assumption]** | |
| `booking:cancel:any` | Cancel a booking on a customer's behalf **[Assumption]** | |
| `refund:issue` | Issue a goodwill refund up to the cap | Yes |
| `refund:approve` | Approve a refund above the cap | Yes |

## 3. Default roles

The four built-in roles (`system: true`) cannot be deleted. An admin may edit their permissions, but not their `key`. Guests have no role. `CUSTOMER` holds no catalogue permissions: searching, booking and managing one's own bookings are `self` operations.

Legend: ✓ grants it by the PRD matrix · ✓* **[Assumption]** · blank means not granted.

| Key | `CUSTOMER` | `OPERATOR` | `SUPPORT_AGENT` | `ADMIN` |
|---|:-:|:-:|:-:|:-:|
| `user:manage` | | | | ✓ |
| `user:read:any` | | | ✓* | ✓ |
| `user:read:tenant` | | ✓* | | ✓ |
| `role:manage` | | | | ✓ |
| `operator:manage` | | | | ✓ |
| `operator:read:own` | | ✓ | | ✓ |
| `inventory:read` | | ✓ | | ✓ |
| `inventory:create` | | ✓ | | ✓ |
| `inventory:update` | | ✓ | | ✓ |
| `inventory:delete` | | ✓ | | ✓ |
| `schedule:read` | | ✓ | | ✓ |
| `schedule:manage` | | ✓ | | ✓ |
| `schedule:cancel` | | ✓ (own tenant) | | ✓ |
| `movie:manage` | | | | ✓ |
| `station:manage` | | | | ✓* |
| `policy:manage` | | | | ✓ |
| `fee:manage` | | | | ✓ |
| `booking:read:any` | | | ✓ | ✓ |
| `booking:read:tenant` | | ✓ | | ✓ |
| `booking:cancel:any` | | | ✓* | ✓ |
| `refund:issue` | | | ✓ | ✓ |
| `refund:approve` | | | | ✓ |

Operator grants are tenant-scoped by the token's `tenantId`, which comes from the verified token and never from a request. Another tenant's resources answer `404`.

## 4. Open questions

1. **Recent login for candidates.** Should `operator:manage`, `schedule:cancel` and `fee:manage` also require a recent login? Cancelling a show triggers mass refunds, and fees change revenue.
2. **Who owns stations?** Movies are decided: they are global and admin-curated, so only `ADMIN` holds `movie:manage` ([ADR-0015](./adr/0015-multi-tenancy-enforcement.md)). The grant above assumes stations are platform-only; the PRD does not say.
3. **Support access to users.** Does `SUPPORT_AGENT` need `user:read:any` to look up a customer, or is `booking:read:any` enough?
4. **Billing and notification permissions.** None exist yet. Add them when the payment, booking and notification specs are written.
