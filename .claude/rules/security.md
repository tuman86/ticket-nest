---
paths:
  - 'services/**'
---

# Security (services)

## Passwords

- Hash passwords with argon2id. Never use bcrypt, SHA-*, MD5 or a hand-rolled scheme.
- Keep the argon2 parameters (memory, iterations, parallelism) as named constants and never inline them.
- Never store, return or log a plaintext password. Never put a password hash in an API response or event.

## Tokens

- Sign JWTs with an asymmetric algorithm (RS256 or EdDSA). Never use HS256 or a shared secret.
- Only auth-service holds the private key. Other services and the gateway verify with the public key.
- Verify `alg`, `iss`, `aud` and `exp` on every token. Never accept `alg: none`.
- Access tokens expire in 10 minutes (`ACCESS_TOKEN_TTL_MS`). Never issue a long-lived access token.
- Store refresh tokens hashed (SHA-256 of a random 256-bit value). Never store the raw token.
- Rotate the refresh token on every use: revoke the old one and issue a new one in a single transaction.
- Reusing an already-rotated refresh token is theft. Revoke the whole token family.

## Authentication responses

- Return the same generic message, status and shape for every login failure ("Invalid email or password"). Never say which part was wrong.
- Verify against a dummy hash when the user does not exist, so timing does not reveal accounts.
- Do the same for registration, password reset and OTP requests. The response must not reveal whether an email exists.
- Rate limit every auth endpoint (login, register, refresh, OTP, password reset) with a Redis-backed limiter, keyed by IP and by account identifier.
- Return `429` with `Retry-After`. Limits are named constants.

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
