## 2026-10-07 - OpenGateway HTTP refresh failures retain status (senpi#2893)

### What changed

- `packages/ai/src/providers/opengateway-refresh.ts`: use the shared status-bearing HTTP error for catalog refresh failures without changing the message or last-good-catalog policy.

### Why

Refresh failure consumers need the original HTTP fact rather than message parsing.

### Why an extension could not handle it

The catalog's private fetch helper creates the failure.

### Expected merge conflict zones

- `fetchJson` in `opengateway-refresh.ts`.
