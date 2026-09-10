# packages/ai/src/tool-call-middleware/protocols/anthropic-xml

Generated: 2026-09-10. Commit `2d0fa41c5`.

## OVERVIEW

Strict Anthropic XML formatting/coercion plus shared invoke scanners consumed by ANTML and leaked-call recovery. Score 8: exported parser boundary with dense shared implementation.

## WHERE TO LOOK

| Task | File |
|---|---|
| Configurable invoke parser contract | `invoke-protocol.ts` |
| Tag syntax and nested block scanning | `invoke-tag-syntax.ts`, `invoke-tag-scanner.ts`, `invoke-match.ts` |
| Batch call extraction | `parse.ts` |
| Incremental invoke parsing | `stream.ts`, `invoke-stream-helpers.ts` |
| Incremental close matching and retained-input limit | `stream-boundary.ts` |
| Strict schema-aware parameter conversion | `coerce-parameters.ts`, `xml-entities.ts` |
| Tool/system/result serialization | `format.ts` |
| Eager leaked-call recovery state machine | `recovery-stream.ts`, `recovery-wrapper-state.ts` |
| Registered-tool wire alias lookup | `tool-resolver.ts` |

## CONVENTIONS

- Strict coercion rejects duplicate parameter names and validates the assembled record with `Value.Check`.
- Remove one raw boundary newline on each side before XML entity decoding; preserve meaningful string whitespace.
- Booleans accept literal `true`/`false`; array/object arguments require valid JSON of the expected shape.
- Parameter keys are defined as own properties, including special property names; do not replace this with unsafe prototype mutation.
- Recovery name lookup prefers exact names, then unambiguous case-insensitive names, then normalized wire aliases.
- Alias normalization strips CC-SDK `mcp__server__tool` and hashed `mcp_<hash>-` prefixes; collisions remain unresolved.
- Retained incomplete invoke fragments are capped at 64 Ki UTF-16 code units by `stream-boundary.ts`.
- Recovery emits an eager start for a known tool. Invalid or interrupted arguments end with `incomplete` and an error, not an executable guessed call.

## ANTI-PATTERNS

- Importing ANTML's lenient coercion into the strict Anthropic XML config.
- Selecting an arbitrary tool after normalized alias collisions.
- Counting the retained-fragment limit as bytes rather than UTF-16 code units.
- Repeatedly rescanning the whole retained fragment instead of feeding the incremental close matcher.

## VALIDATION

- Run `anthropic-xml-*.test.ts` plus `invoke-recovery-tool-alias.test.ts` and `invoke-recovery-resource*.test.ts` under the middleware test directory.
- Shared scanner changes also affect `antml-parser.test.ts`, `antml-stream.test.ts`, and invoke recovery suites.
