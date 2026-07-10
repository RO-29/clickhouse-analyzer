# Security

## Threat model

ch-analyzer is a single binary that (a) holds ClickHouse credentials, (b) exposes
a dashboard/API that can run read SQL, `KILL QUERY`, and mutate alert state, and
(c) can hold a Claude OAuth token. Treat the process and its config as sensitive.

## Dashboard / API authentication

The API is **unauthenticated by default** to preserve the zero-config
single-binary experience on a trusted host. Whenever the port (`:8080` by
default) is reachable beyond localhost, enable token auth:

```yaml
security:
  api_token: "<a long random string>"
```

or set `CH_ANALYZER_API_TOKEN` in the environment (takes precedence, keeps the
secret off disk). When set, every `/api/*` request must present the token as:

- `Authorization: Bearer <token>`, or
- `X-API-Token: <token>`, or
- the `ch_analyzer_token` cookie.

For the bundled UI, open `https://<host>:8080/?token=<token>` once — the server
sets an httpOnly cookie and the SPA's same-origin calls authenticate from then
on. `/health`, `/`, and `/assets/*` stay open so the app can load and load
balancers can probe.

This token gate is a coarse network guard, not per-user auth. For multi-user or
audited access, put ch-analyzer behind an authenticating reverse proxy / SSO.

## ClickHouse TLS

Certificate verification is **on by default**. Only disable it for self-signed
certificates on a trusted network:

```yaml
security:
  tls_skip_verify: true
```

## SQL terminal

The `/api/query` terminal is allowlisted to read statements (first-keyword check
after comment stripping, per-statement) with `max_result_rows` /
`max_execution_time` guards. For defense in depth, point ch-analyzer at a
ClickHouse user with a **`readonly` profile** so the database itself refuses
writes/DDL regardless of the application layer.

## Pipeline-bypassing endpoints

`POST /api/alerts/trigger` (used by Run Check's "promote finding to alert"
action) writes an alert directly to the store, bypassing inhibition and
notification. This is intentional for a manual, operator-initiated promotion,
and — like every `/api/*` route — it is covered by the API-token gate when
`api_token` is set. Do not expose the port without a token.

## Credentials on disk

Never commit real credentials. `configs/staging-env.yaml`, `*-staging.yaml`,
`**/ai-changes-md/`, and `.env*` are git-ignored repo-locally. If a credential
was ever written to one of these files, **rotate it** — git-ignore prevents
future commits but does not undo exposure. Prefer environment variables or a
secrets manager over plaintext config for passwords.
