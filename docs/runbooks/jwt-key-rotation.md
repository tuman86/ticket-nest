# Runbook: rotating the access-token signing key

Applies to `auth-service` (ADR-0013). Only the key that signs new access tokens is secret; every other key in the set is public and verifies only.

## How the key set is configured

| Variable                     | Holds                                                                  | Role                                    |
| ---------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| `JWT_PRIVATE_KEY`            | base64 of the PKCS#8 PEM of an Ed25519 private key                     | The **only** key that signs             |
| `JWT_ADDITIONAL_PUBLIC_KEYS` | comma-separated base64 of SPKI PEMs of Ed25519 public keys (at most 3) | Verify-only: a retiring or upcoming key |

- A key's `kid` is its RFC 7638 thumbprint, computed at startup. There is no key id to configure and none that can mismatch its key.
- `GET /.well-known/jwks.json` lists the signing key first, then the additional keys. The same key set drives the token signer and the `/me` verifier.
- A private key, a non-Ed25519 key, a duplicate, or a fourth additional key stops the service at startup with a message naming the variable (never the key).
- Changing keys is a config change plus a restart (a rolling restart of every replica).

## Why the waits exist

The key set response carries `Cache-Control: public, max-age=300`. A verifier (the gateway, another service) may keep using the set it fetched for up to **300 s**, and a gateway cache in front of it can add its own delay. So:

- A new key must be **published at least `max-age` before it signs**, or a verifier holding the old set rejects the first tokens it signs (it refetches on an unknown `kid`, but do not rely on that for every request).
- An old key must **stay published until the last token it signed has expired**, `ACCESS_TOKEN_TTL` = 10 minutes after its last signature.

During a rolling deploy replicas disagree for a while. Start every clock below when the **last** replica has restarted, not when the deploy began.

## Planned rotation

Generate the new pair on a trusted machine. Never commit it, never paste the private key into a ticket or chat.

```sh
openssl genpkey -algorithm ed25519 -out new.pem
openssl pkey -in new.pem -pubout | base64 | tr -d '\n'      # new public key, for JWT_ADDITIONAL_PUBLIC_KEYS
base64 < new.pem | tr -d '\n'                               # new private key, for the secret manager (step 3)
```

1. **Publish the new key.** Append the new public key to `JWT_ADDITIONAL_PUBLIC_KEYS`. Roll out. The old key still signs.
2. **Wait 300 s plus the rollout time** (`JWKS_CACHE_MAX_AGE_SECONDS`, counted from the last replica). Check `GET /.well-known/jwks.json` on every replica: it lists both `kid`s and they agree (same `ETag`).
3. **Swap the signer.** Set `JWT_PRIVATE_KEY` to the new private key. In `JWT_ADDITIONAL_PUBLIC_KEYS` replace the new public key with the **old** public key (`openssl pkey -in old.pem -pubout`). Roll out. New tokens now carry the new `kid`; the old key still verifies tokens already issued.
4. **Wait 10 minutes** (`ACCESS_TOKEN_TTL_MS`) after the last replica started signing with the new key, plus a minute for clock skew.
5. **Remove the old key.** Delete it from `JWT_ADDITIONAL_PUBLIC_KEYS`. Roll out. Destroy the old private key.

Refresh tokens are opaque and unaffected by any of this. A user whose access token is refused simply refreshes.

## Emergency rotation (private key leaked)

Do not overlap: the old key can forge any role until it is gone.

1. Generate a new pair (above). Set `JWT_PRIVATE_KEY` to the new private key and **leave the old public key out** of `JWT_ADDITIONAL_PUBLIC_KEYS`.
2. Roll out immediately. Every access token signed by the old key is refused, including legitimate ones. Clients recover through their refresh tokens, so users stay signed in.
3. Verifiers that cached the old set accept forged tokens for up to 300 s longer. If that is unacceptable, restart or flush the gateway's key cache as well.
4. If refresh tokens may also be compromised, revoke the affected token families in the database (a separate procedure).
5. Rotate the key's storage credentials and record the incident.

## Checks after any rotation

- `GET /.well-known/jwks.json` lists exactly the `kid`s you expect, and no member named `d`, `p`, `q`, `dp`, `dq` or `qi`.
- A fresh login returns an access token whose header `kid` equals the first key in the set.
- `GET /v1/users/me` with that token answers 200.
