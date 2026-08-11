# packages/ai

Generated: 2026-08-07. Commit `4f26b8282`.

`@earendil-works/pi-ai` is the provider-neutral streaming, model, auth, tool-call, and image API used across the monorepo. Its root surface must remain browser-safe.

## STRUCTURE

```text
src/types.ts                    Core API/model/message contracts
src/model.ts                    Model shape; now carries upstreamModelId + serviceTier ("auto"|"flex"|"priority", backs -fast priority variants)
src/compat.ts                   Temporary legacy dispatch, registry, catalogs
src/api-registry.ts             API registration/lookup
src/model-catalog.ts            Catalog assembly over static + dynamic models
src/models-store.ts             Persisted dynamic-model store
src/api/                        Wire/API implementations and lazy wrappers
src/providers/                  Provider factories, catalogs, shared transforms
src/providers/data/             COMMITTED generated per-provider model JSON (see below)
src/auth/                       Credential stores, contexts, auth helpers/types
src/node/provider-scope.ts      Node-only subpath (provider scoping); not root-reachable
src/oauth.ts                    OAuth surface re-exports
src/openai-responses-compat.ts  Responses-API compat shims
src/stream.ts                   Stream entry points
src/session-resources.ts        Per-session resource plumbing
src/context-provenance.ts       Context provenance tracking
src/legacy-api-aliases.ts       Old API-id aliases
src/compat/                     extension-oauth-types.ts
src/models.ts                   Models/provider/auth/refresh runtime (owns provider registration, auth resolution, dynamic catalog refresh, stream delegation)
src/models.generated.ts         Generated static catalog
src/image-models.ts             Image model surface (+ image-models.generated.ts)
src/images.ts                   Image generation API (+ images-api-registry.ts, images-models.ts)
src/env-api-keys.ts             Browser-safe credential detection boundary
src/tool-call-middleware/       Text-encoded tool protocols
src/utils/                      ~29 files; key: retry.ts, provider-retry.ts, retry-hint.ts, prompt-cache-ttl.ts, stop-details.ts, tool-call-id.ts, tool-schema-compat.ts
scripts/generate-models.ts      Model catalog source of truth
scripts/generate-image-models.ts Image catalog source of truth
test/                           Faux-first and opt-in live tests
```

## MODEL DATA GENERATION

- `src/providers/data/` is committed generated source: 38 provider JSONs plus `.manifest.json` (schemaVersion 3, sha256 map per file + structureHash). Never hand-edit.
- Ordinary build copies `data/` into `dist` (`build:offline` runs `check:model-data` first, then `shx cp -r src/providers/data dist/providers/data`). No network.
- Networked regeneration is explicit: `npm run generate-models` (full) or `npm run hydrate-model-data` (`--data-only`).
- Validators: `scripts/model-data.ts` (shared schema/load) and `scripts/check-model-data.ts` (`npm run check:model-data`).

## ARCHITECTURE

- Provider factories and model catalogs live in `src/providers/`; wire protocol implementations live in `src/api/`.
- `src/api/lazy.ts` exposes `lazyApi()`. API-specific `*.lazy.ts` wrappers are the documented dynamic-import boundary.
- `src/providers/register-builtins.ts` registers compatibility behavior and currently imports only `src/compat.ts`; do not restore the old provider-loader architecture there.
- Public provider and API wildcard subpaths are declared in `package.json`. Keep root exports browser-safe.
- Message transforms return new structures; never mutate shared input messages.

## WHERE TO LOOK

| Task | Path |
|---|---|
| Add or change a wire protocol | `src/api/` |
| Add provider metadata/factory | `src/providers/` |
| Translate reasoning/tool options | `src/api/simple-options.ts` |
| Cross-provider message coercion | `src/api/transform-messages.ts` |
| Add auth detection | `src/env-api-keys.ts` |
| Change auth context/storage | `src/auth/` |
| Model runtime/provider auth/refresh | `src/models.ts`, `src/auth/`, `src/providers/all.ts` |
| Change model inventory | `scripts/generate-models.ts` |
| Add text-tool protocol | `src/tool-call-middleware/` |
| Provider checklist | `README.md` provider section |

## INVARIANTS

- Dynamic imports are limited to lazy API and browser-safe credential/OAuth boundaries; ordinary source uses top-level imports.
- Generated model files are never hand-edited. Regenerate and commit intentional catalog changes.
- Unit tests use `src/providers/faux.ts`; live APIs require explicit key/feature gating and must not be part of default success.
- Keep `extraBody`, tool definitions, reasoning options, usage, stop reasons, errors, and abort behavior consistent across APIs.
- Inspect installed SDK types before changing external request/response shapes.
- Preserve browser smoke coverage when changing exports or imports.

## VALIDATION

- Run the affected focused Vitest file, then `npm test` for broad provider changes.
- Run `npm run check:browser-smoke` from the root for import/export boundary changes.
- Runtime changes require root `npm run check` and real CLI QA evidence.
- Read `src/changes.md` and the nearest child `AGENTS.md` before editing provider or middleware internals.
