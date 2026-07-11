# Auth Broker and Gateway

The auth broker owns credential material. The gateway receives a one-use selected credential for one outbound provider call. Do not expose either service directly to the internet.

## Local setup

```bash
senpi auth-broker token
senpi auth-broker login openai-codex --identity=account:primary
senpi auth-broker serve --bind=127.0.0.1:8765
senpi auth-gateway token
senpi auth-gateway serve --bind=127.0.0.1:4000 \
  --model=openai-codex/gpt-5 \
  --model=anthropic/claude-sonnet-4-5
```

`auth-broker.sqlite`, `auth-broker.token`, and `auth-gateway.token` are in the agent directory (`~/.senpi/agent` by default). The directory is mode `0700`; token and backup files are mode `0600`. Use `senpi auth-broker status --json`, `senpi auth-gateway status --json`, and `senpi auth-gateway check --json` for redacted operational status.

## Remote deployment and CORS

The broker accepts loopback binds only. Keep it on the trusted gateway host, or use a private TLS tunnel with mutual TLS authentication. Never publish broker tokens, vault files, or broker HTTP endpoints.

The gateway defaults to loopback. A remote gateway needs a deliberate TLS-terminating reverse proxy, bearer-token protection, request limits, sanitized logs, and exact CORS origins. CORS is disabled unless an exact origin is configured; wildcard origins are not supported. Do not forward client `Authorization` headers to providers.

## Tokens, model IDs, and selectors

Rotate a token and restart the affected service:

```bash
senpi auth-broker token --regenerate
senpi auth-gateway token --regenerate
```

Keep replacement tokens in a secret manager or `0600` file, never in shell history, source control, issues, or paste services. Gateway model IDs use `provider/model`, for example `openai-codex/gpt-5` and `anthropic/claude-sonnet-4-5`. Broker selectors are `automatic`, `credential`, and `identity`. Explicit selectors never fall back to another account. Identity must be a verified account/email/project value or an operator label, not a value inferred from a token.

## Import, backup, restore, and rollback

| Format | Invocation | Required shape |
| --- | --- | --- |
| Senpi backup v1 | `senpi auth-broker import backup.json` | `format: "senpi-auth-broker-backup"`, `version: 1`, and SHA-256 credential manifest |
| Gajae legacy snapshot | `senpi auth-broker import snapshot.json --format=gajae-snapshot-legacy` | Unversioned `generation`, `generatedAt`, and `credentials` only |
| CLIProxyAPI v6 | `senpi auth-broker import credentials.json` | `version: 6` and `credentials` only |

Unknown versions, fields, credential kinds, duplicate provider/type/identity entries, and secret-reference placeholders are rejected. Imports preserve provider, kind, account/email/project identity, disabled cause, and timestamps. Preview before writing:

```bash
senpi auth-broker import credentials.json --dry-run --json
senpi auth-broker import credentials.json
```

Create and validate a rollback point before migration or account cleanup:

```bash
senpi auth-broker backup ~/senpi-broker-backup.json
senpi auth-broker restore ~/senpi-broker-backup.json --dry-run
senpi auth-broker restore ~/senpi-broker-backup.json
```

Restore validates the manifest before a write transaction. If migration fails, stop the gateway, restore the last known-good backup, verify redacted status, then restart both services. `migrate --from-local` separately requires its matching dry-run backup receipt; do not delete `auth.json` until restore has been tested.

## Incident response

1. Stop broker and gateway if a token, backup, or credential may be exposed.
2. Rotate broker and gateway tokens, then revoke or rotate the exposed provider credential.
3. Preserve only sanitized diagnostics. Never attach vault files, backup JSON, request headers, or secret-bearing terminal transcripts to an incident.
4. Restore a manifest-validated backup if data integrity is uncertain, then run `status --json` and `check --json`.
5. Review gateway bind, proxy TLS, exact CORS origins, and secret-manager access before returning service to use.
