# packages/ai/src

Generated: 2026-08-24. Commit `baf15a54d`.

Entry-surface discipline and the API-provider scope model. Directory structure is mapped in the parent `packages/ai/AGENTS.md`; children own the deep guidance (`api/`, `auth/`, `providers/`, `tool-call-middleware/`, `utils/`).

## ENTRY SURFACES

| Entry | Loads | Use for |
|---|---|---|
| `index.ts` | Side-effect-free core only: types, option types, lazy API factories, cursor arg helpers, provenance, wire-identity. No catalogs, no provider factories, no registry, no OAuth, no compat (its header comment is the contract) | Browser-safe imports |
| `compat.ts` | `index` + legacy dispatch + builtin API registration + env keys + image surface + legacy aliases | Legacy/global API, registration side effects |
| `stream.ts` | Re-exports `complete`, `completeSimple`, `stream`, `streamSimple` from compat | One-line stream imports |
| `images.ts` | Image generation; resolves `model.api` through `getImagesApiProvider`, triggers image registration via side-effect import | Image generation |
| `cli.ts` | Node CLI (`#!/usr/bin/env node`) | Auth flows from the shell |
| `oauth.ts` / `bun-oauth.ts` | OAuth re-exports / Bun registration | OAuth surfaces |
| `node/provider-scope.ts` | Node-only subpath (`@earendil-works/pi-ai/node/*`); NOT root-reachable | Installing a provider scope |

## PROVIDER SCOPE (api-registry.ts)

- `ProviderScope` has `active|closed` state plus a per-scope overlay `Map`. In an active scope, lookup = `session overlay → immutable builtin set` — **NEVER the mutable legacy global** (recorded invariant in `changes.md`).
- A closed scope throws on any lookup/mutation; no silent fallback.
- Builtin entries register once and retain immutable identity for active scopes; `getBuiltinProvider*` must keep working while a scope holds unrelated overlay entries.
- The images registry (`images-api-registry.ts`) is scoped identically.
- `providerScopeStrictMode` makes scope-less lookup throw instead of using the global registry.

## CONVENTIONS

- `KnownApi`/`Provider` ids are open string unions (`KnownApi | (string & {})`), not enums; `legacy-api-aliases.ts` carries the old ids — extend it when renaming an api.
- `model-catalog.ts` `flattenModelCatalog` turns grouped JSON into the flat typed catalog every `*.models.ts` reuses; `models.generated.ts` / `image-models.generated.ts` are generated (never hand-edit — see `../scripts/AGENTS.md`).
- `xml` is retained only as a deprecated alias of `morph-xml` in tool-call format strings.
- `changes.md` (2.7k lines) is the design history for registry, catalog, OAuth, and Cursor invariants — read the relevant dated section before touching any of those.

## ANTI-PATTERNS

- Adding generated catalogs, provider factories, OAuth, or compat side effects to `index.ts`.
- Falling back from an active scope overlay to the mutable legacy provider set.
- Letting external image providers extend the generated `IMAGE_MODELS` catalog or builtin list instead of the images registry.
- Bypassing provider-managed request fields via `StreamOptions.extraBody` — builders reserve and protect those keys.
