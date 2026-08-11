# packages/ai/src/providers

Generated: 2026-08-07. Commit `4f26b8282`.

This directory owns provider factories, catalogs, provider metadata, and the faux test provider. API wire implementations, option translation, and message transforms live in sibling `../api/`.

## FILE MAP

```text
register-builtins.ts     Compatibility registration through src/compat.ts
all.ts                   Builtin provider/model aggregation
faux.ts                  Deterministic public test provider
*-models.ts              Provider model/catalog helpers where present
images/                  Image-provider metadata and factories
radius.ts                Dynamic Radius provider with persisted model refresh
radius-config.ts         Radius gateway/model catalog loading
data/                    38 provider JSONs + .manifest.json — committed generated artifacts
data-json.d.ts           Typed import shim for data/ JSON
ollama.ts                Dynamic provider, no .models.ts; runtime catalog via /api/tags
cloudflare-auth.ts       Cloudflare auth split out of the two Cloudflare providers
cloudflare-stream.ts     Shared Cloudflare stream plumbing
google-shared.ts         Shared google/google-vertex catalog logic
openai-responses-shared.ts Shared openai/azure Responses catalog logic
```

Newer providers on disk (each `<name>.ts` + `<name>.models.ts`): ant-ling, kimi-coding, opencode, opencode-go, vercel-ai-gateway, xiaomi + xiaomi-token-plan-{ams,cn,sgp}, zai, zai-coding-cn.

## ADD OR CHANGE A PROVIDER

1. Define or update the provider factory/catalog in this directory.
2. Implement wire streaming in `../api/<api>.ts`; use `../api/<api>.lazy.ts` when async loading is required.
3. Export public provider/API entry points through `packages/ai/package.json` subpaths.
4. Map simple options in `../api/simple-options.ts` and wire-shape conversions in `../api/transform-messages.ts`.
5. Update credential detection, model generation, and the provider matrix described in `packages/ai/README.md`.
6. Regenerate model artifacts instead of editing generated files.
7. Add faux-first tests and opt-in live coverage only where endpoint behavior must be verified.

## INVARIANTS

- Do not put wire clients back into provider factories or restore lazy registration in `register-builtins.ts`.
- Dynamic providers expose last-known models synchronously and refresh through the ModelsStore/auth-aware refresh path; implement `refreshModels`, cache restore/write, abort handling, and failure retention.
- `../api/transform-messages.ts` is the canonical cross-provider coercion boundary and must not mutate source messages.
- Keep provider-specific quirks local; shared behavior belongs in clearly named shared modules.
- Every API stream must preserve tool calls, thinking blocks, usage accounting, stop reasons, setup errors, and abort semantics.
- Default tests run with zero credentials. Use the faux provider for deterministic event sequences.
- Keep image providers structurally separate under `images/`.
- `data/` is committed generated source; never hand-edit. Regenerate with `npm run hydrate-model-data`, validate with `npm run check:model-data`.

## ANTI-PATTERNS

- Hardcoded model inventories in runtime provider files.
- Static Node-only imports reachable from the package root.
- Guessing SDK types or silently dropping provider-specific options.
- Real-key tests without explicit environment gating.

## VALIDATION

- Run focused tests for the changed API/provider plus the applicable cross-provider matrix tests.
- Run model generation only for intentional catalog changes and inspect the generated diff.
- Export/import changes require the root browser smoke check; runtime changes require the root QA evidence gate.
