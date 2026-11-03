---
paths:
  - 'services/**'
---

# Security (services)

## Passwords

- Hash passwords with argon2id. Never use bcrypt, SHA-*, MD5 or a hand-rolled scheme.
- Use Node's built-in async `crypto.argon2` (Node 24.7+) behind the `PasswordHasher` interface. No native addon. Use a random 16-byte salt per hash and store the result as a PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`).
- Keep the argon2 parameters (memory, iterations, parallelism) as named constants, never inline them, and never below the OWASP minimum (19 MiB, 2 iterations, 1 lane). On verify, read the parameters from the stored string, not from the constants, so raising them later does not break old hashes.
- Compare hashes with `timingSafeEqual`. A malformed stored hash is a failed verification, never a thrown error that reaches the client.
- Never store, return or log a plaintext password. Never put a password hash in an API response or event.

## Tokens

- Sign JWTs with an asymmetric algorithm (RS256 or EdDSA). Never use HS256 or a shared secret.
- Only auth-service holds the private key. Other services and the gateway verify with the public key.
- Verify `alg`, `iss`, `aud` and `exp` on every token. Never accept `alg: none`.
- Access tokens expire in 10 minutes (`ACCESS_TOKEN_TTL_MS`). Never issue a long-lived access token.
- Return `Cache-Control: no-store` on every response that carries tokens.
- Store refresh tokens hashed (SHA-256 of a random 256-bit value). Never store the raw token.
- Rotate the refresh token on every use: revoke the old one and issue a new one in a single transaction.
- Mark rotation with `rotatedAt` and `replacedById`, and use `revokedAt` only for logout, password change and reuse. Rotate with a conditional update (only while neither rotated nor revoked) and check the affected row count. Never check-then-update in application code.
- Reusing an already-rotated refresh token is theft. Revoke the whole token family in its own transaction that commits before the error is thrown, and log a security event with `userId` and `familyId` only. The one exception is a replay within `REFRESH_REUSE_GRACE_MS` (default 10 s, at most 30 s) of the rotation while `revokedAt` is null: answer the standard 401 and leave the family alone. Never return the successor (only its hash is stored). A revoked token always gets a plain 401.
- Re-read the user on every refresh (refuse a missing or `DISABLED` user) and take the role and tenant from the database, not from the old token.
- Refresh tokens expire after 7 days idle (`REFRESH_IDLE_TTL_MS`) and 30 days after login (`REFRESH_ABSOLUTE_TTL_MS`). Never extend a family past the absolute cap.
- Put `auth_time` (last password login) in the access token. A refresh must copy it unchanged, never reset it.
- Reject operations marked `x-recent-login: true` when `auth_time` is older than 5 minutes (`RECENT_LOGIN_MAX_AGE_MS`) with `reauthentication-required`.

## Authentication responses

- Return the same generic message, status and shape for every login failure ("Invalid email or password"). Never say which part was wrong.
- Verify against a dummy hash when the user does not exist, so timing does not reveal accounts. Disabled users get the same 401 as a wrong password (verify their real hash first, then reject).
- Never log the email on a failed login.
- Refresh answers every failure with the same `invalid-refresh-token` 401 and detail. Log the reason (ids only, never a token or hash), not the response.
- Do the same for password reset and OTP requests, and for refresh. The response must not reveal whether an email exists. (Registration is the one exception, below.)
- Registration may answer `409 email-already-registered` for a taken email (ADR-0013). That makes it an account-enumeration oracle, so it is rate limited by IP and by email (ADR-0013). Never log the email on the 409 path.
- Rate limit every auth endpoint (login, register, refresh, OTP, password reset) with a Redis-backed limiter, keyed by IP and by account identifier.
- Return `429` with `Retry-After` and the `RateLimit-*` headers. Limits are named constants (`src/rate-limit/rate-limit-constants.ts`), and each endpoint's rules are one policy in `rate-limit-policies.ts`.
- Never put a plaintext email or refresh token in a Redis key: the key holds an HMAC with `RATE_LIMIT_KEY_PEPPER`. Never log a rate-limit key or identifier, only the policy name.
- Decide what a limiter outage does per policy: register and login fail closed (503 with `Retry-After`), refresh and logout fail open (warning logged).
- Read the client IP only from `request.ip` with `TRUST_PROXY_HOPS` set to the number of proxies in front (0 when none). Never read `X-Forwarded-For` yourself.

## Input

- Parse ALL external input with Zod at the boundary: body, query, params, headers, env, broker messages, webhooks.
- Use `.strict()` on request bodies. Never spread unvalidated input into a Prisma call.
- Never trust `tenantId` or `role` from a request body. Take them from the verified token.

## Queries

- Use Prisma's typed client. Where raw SQL is unavoidable, use the `$queryRaw` tagged template.
- Never use `$queryRawUnsafe` or `$executeRawUnsafe`. Never build SQL with string concatenation or template literals.

## Secrets and logging

- Read secrets only from the Zod-validated env module (`loadConfig`). Never hard-code them, and never commit a `.env`.
- `.env.example` holds variable names only, with no real or realistic values.
- Never log passwords, tokens, OTPs, API keys, private keys or `authorization`/`cookie` headers.
- Redaction covers the top level and one level down only. Never log a nested object that may hold a secret. Log chosen fields instead.
- Never put secrets or personal data in error messages, problem `detail`, events or URLs.
