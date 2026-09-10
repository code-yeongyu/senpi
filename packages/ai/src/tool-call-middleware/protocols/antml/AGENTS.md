# packages/ai/src/tool-call-middleware/protocols/antml

Generated: 2026-09-10. Commit `2d0fa41c5`.

## OVERVIEW

ANTML's Claude-style argument repair policy over the shared invoke parser. Score 8: exported domain boundary with coercion rules that intentionally differ from strict XML.

## WHERE TO LOOK

| Task | File |
|---|---|
| Protocol identity and injected coercer | `config.ts` |
| Parameter aliases, scalar coercion, schema filtering | `coerce-parameters.ts` |
| Broken Unicode escapes and lone-surrogate repair | `repair.ts` |
| Delegate batch, stream, or recovery parsing | `parse.ts`, `stream.ts`, `recovery-stream.ts` |
| Tool-call/system/result formatting | `format.ts` |
| Supported exports | `index.ts` |

## CONVENTIONS

- Resolve declared property names by exact match, then unique case/separator-insensitive match, then the explicit alias groups.
- Alias groups cover file paths, old/new replacement strings, and command/cmd; expand only with schema-backed regression cases.
- Duplicate parameters are last-wins here, unlike strict Anthropic XML's rejection.
- Recursively filter unknown object keys unless `additionalProperties` permits them or supplies a schema.
- Repairs narrow values; the final `Value.Check` is mandatory. Failed known-value coercion rejects the call.
- Numeric/boolean scalar spellings can be unwrapped from JSON strings; arrays and objects still require parseable JSON of the right shape.
- Broken `\u` escapes are made literal only when malformed and not already escaped. Valid escapes remain unchanged.
- Replace lone UTF-16 surrogates in strings and object keys without destroying valid surrogate pairs.
- Use own-property definitions while rebuilding objects so special keys remain data.

## ANTI-PATTERNS

- Forking the shared invoke scanner to implement an argument-coercion difference.
- Returning repaired arguments before schema validation or converting a failed object parse to a string.
- Globally deleting unknown keys when the schema explicitly permits additional properties.
- Applying Unicode escape repair to already-escaped backslash runs.

## VALIDATION

- Focused coverage: `antml-coerce.test.ts`, `antml-repair.test.ts`, `antml-parser.test.ts`, `antml-stream.test.ts`, and `antml-e2e.test.ts` in the middleware test directory.
- Keep strict Anthropic XML tests unchanged when broadening ANTML-only tolerance.
