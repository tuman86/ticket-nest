# ADR-0013: Authentication and authorization strategy

- **Status:** Proposed (a **[Rec]** decision from [`architecture.md`](../architecture.md) §13, not yet ratified)
- **Date:** 2026-11-02
- **Deciders:** Project owner
- **Related:** [`architecture.md`](../architecture.md) §13 and §14, [`prd.md`](../prd.md) §2.1, [`auth-service.openapi.yaml`](../api/auth-service.openapi.yaml)

## Context and problem

TicketNest has two Next.js apps (`web` for customers, `console` for operators and admins), an API gateway, and five services that each need to know who is calling and what they may do. Customers can be registered users or guests. Operator users are scoped to one tenant.

The design has to satisfy these constraints:

- Zero trust: the gateway **and** every service verify the caller's token. No service trusts a header set by another.
- Database per service: only auth-service owns user, role and token data. Other services must not query it.
- Permissions are editable bundles (PRD §2.1), so the token has to carry them or a service has to look them up.
- Browsers must not be able to steal a long-lived credential through script injection.

## Decision

### Access token

- A JWT signed with **EdDSA** (RS256 is the fallback if a library or gateway lacks EdDSA support). Never a shared secret.
- Lifetime: **10 minutes**.
- Header: `kid`. Claims: `sub`, `role`, `permissions[]`, `tenantId` (operator users only), `auth_time` (when the user last entered their password), `iss`, `aud`, `iat`, `exp`, `jti` (random per token, so a deny-list keyed by token can be added later).
- Signing key: auth-service reads one Ed25519 private key from the environment (`JWT_PRIVATE_KEY`, base64 of the PKCS#8 PEM, with `JWT_ISSUER`, `JWT_AUDIENCE`). It is validated at startup and never committed. Only this key signs.
- Key id: the `kid` of a key is its RFC 7638 JWK thumbprint, computed at startup, so it cannot mismatch its key and needs no configuration. (An earlier draft used a configured `JWT_KEY_ID`; it was removed. Tokens issued under the old id are refused for at most one access-token lifetime.)
- Verify-only keys: `JWT_ADDITIONAL_PUBLIC_KEYS` (comma-separated base64 SPKI PEMs, at most 3, Ed25519 only) holds a retiring key or an upcoming key. They are published in the JWKS and verify tokens, never sign. A private key, a non-Ed25519 key or a duplicate stops startup.
- Until the permission catalogue is seeded in auth-service's database, `permissions[]` is issued empty.
- auth-service publishes the public keys at `/.well-known/jwks.json` (unversioned, unauthenticated, `GET`/`HEAD` only, media type `application/jwk-set+json`). The gateway and every service verify with the public key only, cache the key set, and refetch it (with a cooldown) when they see an unknown `kid`. Only auth-service holds the private key. The endpoint is for platform-internal callers: it is not routed through the gateway for now.
- The key set is built once at startup, never per request. It is served with a strong `ETag` (304 on `If-None-Match`) and `Cache-Control: public, max-age=300`.
- Key rotation works by overlap: publish the new key, **wait at least the 300 s cache lifetime** (counted from the last replica), start signing with it, and keep the old public key in the set until the last token signed with it has expired (10 minutes). Steps and the emergency variant are in `docs/runbooks/jwt-key-rotation.md`.
- Verifiers check `alg`, `iss`, `aud` and `exp` on every request and reject anything else.
- Verification lives in `packages/auth-middleware` (`@ticketnest/auth-middleware`). auth-service uses it today (`GET /v1/users/me`); the gateway and every other service use the same package as they are built. `JwtAccessTokenVerifier` accepts only `EdDSA`, a `kid` that its `KeyResolver` knows, and the configured `iss` and `aud`, with 5 s of tolerance past `exp` (`ACCESS_TOKEN_CLOCK_TOLERANCE_MS`). Every invalid token answers one identical `401`.
- Where the keys come from is behind the `KeyResolver` interface:
  - auth-service uses `StaticKeyResolver` over the same in-memory key set it publishes, so it never calls its own endpoint and the two cannot disagree. It also uses no clock tolerance, because the signer and the verifier share one clock.
  - Every other verifier uses `JwksKeyResolver`. It caches the key set for 300 s (the ceiling above) and refetches with the stored `ETag`. A `kid` it does not know triggers a refetch, at most once per 30 s (`JWKS_REFETCH_COOLDOWN_MS`), so forged key ids cannot flood auth-service. Concurrent lookups share one fetch, and an empty or invalid key set never replaces a good one.
  - If auth-service cannot be reached, the last good key set keeps working for at most 1 hour (`JWKS_STALE_IF_ERROR_MS`, with a warning logged), because stateless verification is meant to survive a short auth-service outage. After that, and when nothing is cached, the verifier answers `503` with `Retry-After`, never `401`: a client with a good token must not sign itself out because of a server problem.

### Refresh token

- An **opaque** random value (256 bits), never a JWT.
- Stored only as a **SHA-256 hash** in auth-service's `RefreshToken` table, with `familyId`, `replacedBy`, `expiresAt` and `revokedAt`.
- **Rotated on every use.** In one transaction the old token is marked as replaced and a new one in the same family is issued.
- **Rotation is marked on the old row** with `rotatedAt` and `replacedById`. `revokedAt` is separate: it means logout, password change or detected reuse. The rotation is a conditional update (only while the token is neither rotated nor revoked), so of several simultaneous requests with one token exactly one wins and the others roll back. The database settles the race, not application code.
- **Reuse detection:** presenting a token that was already rotated, after the grace window below, is treated as theft. The whole family is revoked in its own transaction, which commits before the request fails, and a security event is logged with the user id and family id (never a token value).
- **Grace window:** if the presented token was rotated less than `REFRESH_REUSE_GRACE_MS` ago (default 10 seconds, configurable from 0 to 30 000, where 0 means strict), and it is not revoked, the replay is treated as a retry or a two-tab race. It is answered with the standard `401` and the family is **not** revoked. The successor is never returned a second time: only its hash is stored, and reissuing a token to whoever replays would hand a live session to a thief. A revoked token always gets a plain `401`.
- **One failure for everything.** Unknown, expired, revoked, already used, past the session limit, and disabled user all answer the same `401 invalid-refresh-token` with the same detail. The reason, including reuse, goes to the server log only. There is no separate problem type for a replayed token: telling a caller that a token was replayed helps a thief more than the legitimate client, whose reaction is the same in every case.
- **Fresh data on every refresh.** The user is re-read: a missing or `DISABLED` user is refused, and the role and `tenantId` of the new access token come from the database, so a role change applies at the next refresh. `auth_time` is copied from the session, never reset.
- **Session limits:** each token expires after 7 days idle (`REFRESH_IDLE_TTL_MS`), and the family has a hard cap of 30 days from login (`REFRESH_ABSOLUTE_TTL_MS`). A refresh never extends a family past the cap, so a stolen but regularly used session cannot live forever.
- Logout revokes the whole family of the presented token, so presenting an old, already rotated token still ends the session. It needs no access token, always answers `204` for a well-formed body, and logs the outcome (ids only). Password reset revokes all of the user's tokens. A password change revokes all of the user's other tokens. Disabling a user revokes their tokens.

### Where tokens live in the Next.js apps

- The **refresh token** is kept in an `httpOnly`, `Secure`, `SameSite` cookie. `web` uses `Lax`. `console` uses `Strict`.
- The **access token** is kept in memory only. It is never written to `localStorage`, `sessionStorage` or a readable cookie.
- The auth API returns `refreshToken` in the JSON body (`TokenPair`), so a browser cannot set the cookie by itself. Each app has server-side **Next.js route handlers** under `/api/auth/*` that call the gateway, set and clear the cookie, and return only the access token to the browser. The browser never sees the refresh token. The OpenAPI spec does not change.
- On a full page load the app has no access token. It calls the refresh route handler once to get one.
- The client refreshes proactively at about 80% of the access-token lifetime (around 8 minutes), and retries once after a `401` for an expired token.
- Refresh runs as a single in-flight request per tab. Tabs coordinate with the Web Locks API (`navigator.locks`), so a second tab waits and reads the rotated cookie instead of replaying the old token.
- **The route handler must serialize refreshes per session** (one in flight at a time, a second caller waits and uses the cookie the first one set), **and retry once after a `401` by re-reading the cookie.** Retry only when the re-read cookie holds a different token than the one that was just sent; that is the sign that a parallel request already rotated it. If the cookie is unchanged, do not retry: treat the session as signed out and clear the cookie. Retrying with the same stale token after the grace window would be read as theft and revoke the whole session.
- The two apps use different cookie names, so a customer session cannot be replayed against the console.

### Roles and permissions

This ADR keeps the permission-based RBAC already defined in the PRD. It does not introduce a simple USER/ADMIN split.

| Concept | Rule |
|---|---|
| Roles | Customer, Operator, Support Agent, Admin. Guests have no role and use a separate guest token. |
| Role | A named bundle of permissions. An admin can edit which permissions a role holds. A user holds exactly one role. |
| Permission | A string shaped `resource:action[:scope]`, for example `inventory:create` or `refund:approve`. |
| Claims | `role` and `permissions[]` are copied into the access token at issue time. A permission edit takes effect within one token lifetime (10 minutes). |
| Tenancy | `tenantId` is taken from the verified token, never from a request body. Another tenant's resources answer `404`. |

### Recent login for sensitive actions

Risky actions require a recent password login, instead of shortening every token. Refreshing does not update `auth_time`, so it only moves when the user actually signs in again.

- Sensitive actions: `refund:approve`, `refund:issue`, role and permission edits, `policy:manage`, and user disabling. The final list lives with the permission catalogue.
- The owning service rejects the call when `auth_time` is older than 5 minutes (`RECENT_LOGIN_MAX_AGE_MS`). The client then asks for the password again and receives a token with a new `auth_time`.

### Login

`POST /v1/auth/login` takes an email and a password and returns the `TokenPair` in the JSON body (the cookie is set by the Next.js route handlers, above).

- **One failure for everything.** A wrong password, an unknown email, a user without a password and a disabled user all answer the same `401 invalid-credentials` with the same detail. This replaces the `403 account-disabled` that the first draft of the OpenAPI spec listed: a distinct status for disabled accounts would let anyone confirm that an email has an account.
- **Constant work.** Exactly one argon2id verification runs in every case. When the email is unknown, or the user has no usable hash, it runs against a dummy hash made at startup with the current parameters. A disabled user's real hash is verified before the request is rejected. After the parameters are raised, an account that still has an old, cheaper hash verifies slightly faster than the dummy until its next successful login. This residual difference is accepted.
- **Rehash.** After a successful login, a hash with any parameter below the current one is replaced in the same transaction as the new refresh token. The update is compare-and-set on the old hash, so a password changed while the login was running is never overwritten.
- **Session.** Each login creates a new `familyId` and stores the SHA-256 of the refresh token with the user agent and IP. `auth_time` is the login time. The response carries `Cache-Control: no-store`.
- **Rate limiting.** Login is rate limited by IP and by email, as middleware before the handler (see "Rate limiting" below). The limiter has landed, so the route may be exposed through the gateway.
- Failed logins log an internal reason (`unknown_user`, `bad_password`, `disabled`) and never the email or user id.

### Registration and password hashing

**Registration** (`POST /v1/auth/register`) creates a `CUSTOMER` account only. Staff accounts come from an admin. The role is chosen by the service, never by the request body, and the body schema rejects unknown fields (`role`, `tenantId`, `passwordHash`). It returns `201` with the `User` and issues no tokens. The user logs in afterwards.

| Topic | Rule |
|---|---|
| Duplicate email | `409 email-already-registered`, as in the OpenAPI spec. The email is normalized first (trimmed, lower-cased), and the unique index is the final arbiter if two requests race. |
| Password policy | 10 to 128 characters, no composition rules, and a breached-password check behind a `BreachedPasswordChecker` interface. The first implementation is a small bundled denylist. A k-anonymity lookup against a breach service can replace it later. |
| Response | Built field by field from an allow-list and parsed through the `User` schema. `passwordHash` is never part of any response, log line or event. |
| Verification email | Out of this change. It needs the outbox and the email-verification token flow. Until then `emailVerified` stays `false`. |

**Trade-off: registration may reveal that an email is taken.** The `409` lets a caller probe which emails have accounts. We accept this because the alternative (always answering `202` and emailing the owner "you already have an account") needs the email pipeline first and makes the sign-up form harder to use. The anti-enumeration rule therefore applies to login, refresh, password reset and OTP requests, and registration is the documented exception. In exchange:

- Registration must be rate limited by IP and by email with the Redis-backed limiter, answering `429` with `Retry-After`.
- The limiter has landed (see "Rate limiting" below), so the route may be exposed through the gateway.
- The `409` path never logs the email.
- If the limiter proves too weak, switch to the always-`202` flow. That is an API change and needs a new spec version.

**Password hashing** uses **argon2id** through Node's built-in asynchronous `crypto.argon2` (Node 24.7 or later; this repo requires 24.11). There is no native addon to build, which suits the Alpine image that holds only the Node binary. It runs on the libuv thread pool, so hashing does not block the event loop. The service depends on a `PasswordHasher` interface, and only the composition root names the argon2 class.

| Parameter | Value | Note |
|---|---|---|
| Algorithm | argon2id | Never bcrypt, SHA-* or a custom scheme. |
| Memory | 19 456 KiB (19 MiB) | OWASP minimum for `t=2, p=1`. Raise it, never lower it. |
| Iterations | 2 | OWASP minimum. |
| Parallelism | 1 | OWASP minimum. |
| Salt | 16 random bytes per hash | From `crypto.randomBytes`. |
| Output | 32 bytes | |
| Stored form | PHC string `$argon2id$v=19$m=…,t=…,p=…$salt$hash` | Base64 without padding. |

- **Verify reads the parameters from the stored string**, not from the constants, and compares with `timingSafeEqual`. Raising the constants later therefore does not invalidate old hashes. A login that finds an older parameter set can rehash on success.
- **A malformed or unsupported stored hash is a failed verification**, not a thrown error, so a damaged row can never turn into a `500` that tells an attacker something. Parameters read from a stored string are also bounded before use, so a tampered row cannot request huge memory.
- **Runtime guard:** the hasher refuses to start if `crypto.argon2` is missing. The Dockerfile build stage checks the same Node binary that is copied into the runtime image, so an older Node cannot slip into production.
- **Tests** cover a round trip, a wrong password, unique salts, malformed hashes and a reference vector (RFC 9106 test vector for argon2id), so a change in Node's implementation cannot silently change the output.

### Rate limiting

Register, login, refresh and logout are limited by a Redis-backed fixed-window limiter, shared with the gateway through `packages/rate-limit`. The shape is controller (middleware) -> `RateLimitService` -> `RateLimiter` interface, with the Redis class named only in `server.ts`. auth-service keeps its policies, numbers and the reading of the email and refresh token from the body in `src/rate-limit/`.

| Endpoint | IP limit | Account limit | Window | If Redis is down |
|---|---|---|---|---|
| `POST /v1/auth/register` | 5 | 3 per email | 1 hour | fail closed (503) |
| `POST /v1/auth/login` | 20 | 10 per email | 15 minutes | fail closed (503) |
| `POST /v1/auth/refresh` | 60 | 20 per refresh token | 15 minutes | fail open (warning) |
| `POST /v1/auth/logout` | 60 | none | 15 minutes | fail open (warning) |

- **Fixed window.** One counter per key with a TTL equal to the window, incremented by one Lua script so replicas cannot race. A client can send up to twice the limit across a window boundary; at these limits that is acceptable for brute-force throttling. `Retry-After` is the counter's remaining TTL, rounded up. Every request counts, denied ones too, and a denial does not move the end of the window.
- **Two independent counters.** The IP rule is checked first and checking stops at the first denial, so a blocked IP cannot use up a victim's email counter. A request with no usable email (a malformed body) is counted by IP only and then gets its normal 422. A request with no known IP shares one `unknown` bucket.
- **Keys.** The IP is stored as is. The email (trimmed, lower-cased, like stored accounts) and the refresh token are stored as HMAC-SHA256 with a server-side secret (`RATE_LIMIT_KEY_PEPPER`, at least 32 characters), so Redis holds neither in plaintext and a dump cannot be matched against a list of emails. Logs name the policy only, never a key or identifier.
- **Failure modes.** Register and login fail closed: they are the enumeration and credential-stuffing targets, and each login costs an argon2id verify. Refresh and logout fail open: they need a secret token anyway, and failing them closed would sign everyone out during a Redis blip. A limiter call that takes longer than 500 ms counts as down.
- **Client IP.** `TRUST_PROXY_HOPS` (default 0) sets Express `trust proxy`. At 0 the socket address is used, so a client that reaches the service directly cannot choose its IP; set 1 once the gateway is in front. The gateway layers its own limits on top (`services/api-gateway/src/rate-limit/`): 300 requests per minute per IP on every route before the token is checked, and 120 per minute per signed-in user after it, both failing open because auth-service keeps login and register fail-closed itself (starting values, to be tuned). The gateway sends each service a single `X-Forwarded-For` value, its own resolved `request.ip`, instead of appending to the client's chain, so every service keeps `TRUST_PROXY_HOPS=1` whatever sits in front of the gateway.
- **Known limits.** An attacker can lock a victim's email out of login for up to 15 minutes by exceeding its counter; the per-email limit is generous enough to keep this short-lived. An IPv6 client with a /64 can rotate addresses, so the IPv6 counter should be keyed by /64 later. If the limiter proves too weak for registration, the always-`202` flow stays the fallback.

### Out of scope

- Guest sessions, email OTP and guest-to-account merge: ADR-0014.
- Tenancy enforcement in the repository layer or with row-level security: ADR-0015.
- Other implementation rules: `.claude/rules/security.md`.

## Consequences

**Good**

- Verification is stateless. No request needs a call to auth-service.
- Verifiers hold only a public key, so a compromised service cannot mint tokens.
- A stolen refresh token is detected the first time both the thief and the real user use it.
- A script injected into the page cannot read the refresh token.

**Bad**

- Revocation is delayed by up to the token lifetime. See weak point 1.
- Both Next.js apps need server-side route handlers, which adds an extra hop.
- We own the full authentication surface. See weak point 11.

## Alternatives and trade-offs

### Server-side sessions (opaque session id in Redis or a database)

- **For:** Revocation is immediate, permission changes apply on the next request, the cookie is small, and there is no key management.
- **Against:** Every request needs a session lookup. In a database-per-service design that means either each service calls auth-service, or a shared session store becomes a hot dependency that every service shares. It is also awkward for non-browser clients, and it does not fit the zero-trust rule of verifying at each service without a network call.
- **Verdict:** Rejected. It trades the main weakness of JWTs (slow revocation) for a coupling the architecture is built to avoid.

### Refresh state in Redis instead of Postgres rows

- **Option:** a signed refresh JWT plus one expiring Redis key per session (`session:{familyId}`) holding the current and previous `jti`, instead of one hashed row per token.
- **For:** No growing table and no cleanup job. Sessions expire on their own.
- **Against:** Redis lands on the refresh path, and losing the key logs the user out. The token is a less common shape and exposes readable claims. A row-per-token table needs only Postgres, which auth-service already requires.
- **Verdict:** Not chosen for now. The behavior is the same, so it can replace the table later without changing the API.

### Hosted provider (Auth0, Clerk)

- **For:** MFA, social login, breach detection and bot protection come ready-made. Far less security code to write and maintain. Faster to ship.
- **Against:** Cost per monthly active user, and vendor lock-in. Custom claims such as `tenantId` and editable permission sets need provider hooks or a sync job. User data would live outside our Postgres, which conflicts with auth-service owning users. It would also remove the auth work this demo project exists to practice.
- **Verdict:** Rejected for now. Revisit if MFA, enterprise SSO or social login become requirements, or if the team no longer wants to run auth.

## Weak points of this design

| # | Weak point | Why it matters | Mitigation |
|---|---|---|---|
| 1 | **Revocation lag** | A disabled user, a demoted role or a removed permission keeps working until the access token expires (up to 10 minutes). | Accepted. The OpenAPI spec already states it. Optional later: a Redis deny-list keyed by `sub`, checked at the gateway. |
| 2 | **False positives in reuse detection** | Two tabs refreshing at the same moment, or a retry after a lost response, replay a rotated token. Outside the grace window the family is revoked and the user is logged out everywhere. | Single in-flight refresh per tab, coordinated across tabs with Web Locks, plus the grace window described above: a replay inside it fails with `401` but does not revoke, and the route handler retries once with the re-read cookie. A response lost before the cookie was set still means signing in again, because the successor cannot be returned a second time. A real replay outside the window still revokes the family. |
| 3 | **XSS** | `httpOnly` hides the refresh token, but injected script can still call the refresh route handler and read the in-memory access token while the page is open. | Strict CSP, no `dangerouslySetInnerHTML`, short access-token life. |
| 4 | **CSRF on the refresh route handler** | The cookie is sent automatically. `SameSite` helps but is not a complete defense. | Check the `Origin` header, accept only `POST` with a JSON content type, and keep the cookie path narrow. |
| 5 | **Access token lost on reload** | Every full page load needs a refresh round trip, which adds latency and can flash a logged-out screen. | Accepted. Render a loading state until the first refresh settles. |
| 6 | **Auth-service on the refresh path** | Each refresh is a database write. If auth-service is down, users are signed out after at most 10 minutes. | Index on the token hash, run several replicas, and clean up expired rows with a scheduled job. |
| 7 | **Key management** | The private key can forge any role. A verifier that caches JWKS for too long rejects tokens from a new key. A leaked key stays dangerous until it is rotated out. | Keep the key in Secrets Manager, the rotation and emergency-rotation runbook is `docs/runbooks/jwt-key-rotation.md`, the JWKS cache lifetime is capped at 300 s, and verifiers refetch on unknown `kid` with a cooldown. |
| 8 | **Token size** | `permissions[]` is sent on every request and grows with the role's permission list. | Cap the permission count, or move to role-only claims plus a lookup if tokens get large. |
| 9 | **Coupling to Next.js server code** | The cookie flow depends on route handlers in both apps. A future mobile client cannot use cookies and would need its own token storage. | Accepted. Keep the auth API itself client-neutral, as it is today. |
| 10 | **Two apps, two cookies** | A mistake in cookie names or domains could let a customer session reach the console. | Separate cookie names, `Strict` on the console, and an authorization check in the console on every call regardless of the cookie. |
| 11 | **We own the whole auth surface** | Credential stuffing, account enumeration, password reset abuse and OTP abuse are our problem. There is no MFA. | Rate limiting, generic login errors and the other rules in `.claude/rules/security.md`. MFA stays out of scope. |
| 12 | **Token family table growth** | Every refresh adds a row, and old rows pile up. | Keep rows until `expiresAt` plus a retention period, then delete them in batches. The 30-day absolute cap bounds how long any family can live. |
| 13 | **Registration reveals taken emails** | `409 email-already-registered` lets a caller enumerate accounts. | Rate limit by IP and email, the limiter has landed, never log the email on that path, and keep the always-`202` flow as the fallback. |

## Follow-ups

- Update `auth-service.openapi.yaml`: add the `auth_time` claim to the Tokens section, a `reauthentication-required` problem type, and the idle and absolute session limits.
- Add the permission list for "sensitive actions" to the permission catalogue.
- Build the route handlers when `web` and `console` are bootstrapped.
- Record key storage in ADR-0023 (deployment and secrets). JWKS caching is decided above.
- Write ADR-0014 for guest identity.
