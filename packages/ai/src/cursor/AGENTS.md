# packages/ai/src/cursor

Generated: 2026-09-10. Commit `2d0fa41c5`.

## OVERVIEW

Cursor catalog identity and reasoning selection shared by the native and CLI transports. Score 9: distinct domain, dense exports, 23 measured selection-resolver call sites.

## WHERE TO LOOK

| Task | File |
|---|---|
| Resolve model + thinking selection to wire identity | `selection-descriptor.ts` |
| Render the CLI `--model` argument | `renderCursorCliModelString` in `selection-descriptor.ts` |
| Capability evidence, parameter order, supported levels | `model-capabilities.ts` |
| Known variant spellings | `cursor-variant-aliases.json` |
| Collapse raw catalog variants into selectable entries | `catalog-grouping.ts` |
| Persisted catalog compatibility | `store-migration.ts` |
| Composer-family prompt selection | `composer-prompt.ts`, also consumed by history measurement |
| Native protobuf rendering of the descriptor | `../api/cursor-agent/reasoning-params.ts` |

## CONVENTIONS

- Both transports consume `resolveCursorSelectionDescriptor`; native protobuf and CLI strings must not invent separate reasoning-selection rules.
- With no reasoning compat, selection falls back to `upstreamModelId ?? id` and no parameters.
- With compat but no explicit selection, use the representative variant, not a guessed bare capability id.
- Explicit legacy variants are accepted only when present in the alias catalog; unsupported selections fall back to the representative.
- Supported levels prefer catalog-guaranteed suffix aliases. Bare capability ids can be rejected by Cursor Run; do not synthesize suffixes without alias evidence.
- Parameterized selections follow the capability's `parameterOrder`, including context, thinking, effort/reasoning, and fast flags.
- Catalog level maps reflect observed variants as well as capability support; a capability alone does not prove the server offers a selectable level.

## ANTI-PATTERNS

- Encoding every Cursor id as a generic `<base>-<level>-<mode>` string; alias spellings and thinking placement vary.
- Fixing native transport selection without checking the CLI renderer that consumes the same descriptor.
- Dropping legacy aliases during catalog grouping or stored-model migration.

## VALIDATION

- Focused suites live in `packages/ai/test/cursor-model-grouping.test.ts`, `cursor-model-capabilities.test.ts`, and `cursor-reasoning-params.test.ts`.
- Exercise representative, unsupported, legacy-variant, suffix-alias, and parameterized selections when changing identity rules.
