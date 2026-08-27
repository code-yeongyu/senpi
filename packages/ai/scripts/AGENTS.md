# packages/ai/scripts

Generated: 2026-08-24. Commit `baf15a54d`.

Networked generators that produce the committed model catalogs (`src/providers/data/*.json`, `src/models.generated.ts`, `src/image-models.generated.ts`) plus their validators. Scored 7 but kept: this is the only place the generation contract (flags, staging/rename, manifest hashing) is written down, and the parent file states only the outcome.

## FILE MAP

```text
generate-models.ts             3.4k LOC orchestrator; all four model scripts are flag variants of it
generate-models-opengateway.ts fetchOpenGatewayModels + OpenGatewayReasoningRecorder (enrichment source)
models-dev-reasoning-options.ts getEffortThinkingLevelMap — models.dev effort -> thinkingLevelMap
model-data.ts                  Shared manifest/schema layer: MODEL_DATA_SCHEMA_VERSION=3,
                               createModelDataManifest, validateGeneratedModelData, assertExactModelIds
check-model-data.ts            Thin CLI over validateGeneratedModelData
generate-image-models.ts       Image catalog (OpenRouter `/models?output_modalities=image`)
generate-test-image.ts         Writes test/data/red-circle.png; requires the `canvas` native dep
transform-cursor-agent-proto.mjs Rewrites protoc-gen-es enums to const objects for erasableSyntaxOnly
```

## FLAG CONTRACT (`generate-models.ts`)

| Invocation | Flags | Effect |
|---|---|---|
| `npm run generate-models` | `--strict` | Full: `data/` JSON + `models.generated.ts` |
| `npm run hydrate-model-data` | `--strict --data-only` | `data/` JSON only; rejects any JSON-catalog flag |
| `npm run generate-model-catalog` | `--strict --json-only --json-output <dir>` | Publishable catalog to `.artifacts/model-catalog`; `--json-only` requires `--json-output` |
| `npm run check:model-data` | — | Validates manifest hashes; fails with "run `npm run hydrate:model-data` from the repository root" |

`--strict` turns per-provider fetch failures into a thrown error instead of a skip. Without it a network hiccup silently ships a shrunken catalog — always keep it on for committed regeneration.

## CONVENTIONS

- `data/` writes are staged, not in-place: a `.model-generation-*` temp dir under `src/providers/`, then rename-swap with the previous dir kept for rollback. Never write `data/` file-by-file.
- Every provider fetch skips records with `status === "deprecated"` (five separate call sites) — deprecated upstream models must not enter the catalog.
- `model-data.ts` is the single schema authority: the manifest carries a sha256 per file plus a `structureHash`, so a hand-edit of any JSON fails `check:model-data`.
- Scripts run under `tsx` (see package scripts), use explicit `.ts` import suffixes, and import repo types from `../src/types.ts` — they are type-checked against runtime contracts, not standalone.
- These are the only files in the package that legitimately use bare `fs`/`path` imports rather than `node:`-prefixed ones; leave the style alone unless converting the whole file.

## ANTI-PATTERNS

- Hand-editing `src/providers/data/*.json`, `src/models.generated.ts`, or `src/image-models.generated.ts` instead of rerunning the generator — the manifest will catch it, but only at `check:model-data` time.
- Running generation without `--strict` and committing the diff.
- Adding a provider fetcher that does not honor the deprecated-status skip or the staging/rename path.
- Editing `src/api/cursor-agent/gen/agent_pb.ts` by hand: regenerate via `buf generate` on `proto/cursor/agent.proto`, then `node scripts/transform-cursor-agent-proto.mjs <in> <out>` (the exact `buf` invocation is in that file's header comment).

## VALIDATION

- After any regeneration: `npm run check:model-data`, then inspect the `data/` diff for unintended model removals.
- Root-level entry points are `npm run generate:models`, `npm run hydrate:model-data`, `npm run check:model-data`; the `packages/ai` scripts are what they delegate to.
