# packages/ai

`@earendil-works/pi-ai` is the provider-neutral streaming, model, auth, tool-call, and image API used across the monorepo. Its root surface must remain browser-safe.

## STRUCTURE

```text
src/types.ts                    Core API/model/message contracts
src/compat.ts                   Temporary legacy dispatch, registry, catalogs
src/api/                        Wire/API implementations and lazy wrappers
src/providers/                  Provider factories, catalogs, shared transforms
src/auth/                       Credential stores, contexts, auth helpers/types
src/models*.ts                  Runtime model catalogs; generated files committed
src/env-api-keys.ts             Browser-safe credential detection boundary
src/tool-call-middleware/       Text-encoded tool protocols
scripts/generate-models.ts      Model catalog source of truth
scripts/generate-image-models.ts Image catalog source of truth
test/                           Faux-first and opt-in live tests
```

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
