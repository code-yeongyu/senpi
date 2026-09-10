# packages/ai/src/tool-call-middleware/protocols

Generated: 2026-09-10. Commit `2d0fa41c5`.

## OVERVIEW

Parser implementations beneath the middleware registry; activation and outer stream projection stay in the parent directory. Score 9: dense parsing code and distinct wire-format domains.

## WHERE TO LOOK

| Change | Boundary |
|---|---|
| Hermes-family JSON inside delimiters | `json-mix.ts` shared machinery, `hermes.ts` format binding |
| Morph XML argument structure or truncation | `morph-xml.ts` |
| YAML-valued arguments inside XML | `yaml-xml.ts` |
| Gemma delimiter parser | `gemma4.ts` |
| Shared XML tool-tag recognition | `xml-tool-tag-scanner.ts` |
| Invoke/parameter scanner and stream lifecycle | `anthropic-xml/`; owns shared invoke machinery |
| Claude-style tolerant argument repair | `antml/`; configures the shared invoke implementation |
| Kimi channel markers and thinking recovery | `kimi-xtml/`; separate channel-aware state machine |

## CONVENTIONS

- JSON-delimiter variants reuse `json-mix.ts`; do not copy Hermes parsing into another protocol.
- Invoke-shaped protocols use `InvokeProtocolConfig` from `anthropic-xml/invoke-protocol.ts`, not the JSON-delimiter helper.
- Shared invoke scanning is format-agnostic; protocol identity, call-id prefix, and argument coercion come from that config.
- XML tool-tag scanning and invoke-boundary scanning are different layers. Reuse the matching scanner rather than routing every XML-like protocol through one helper.
- `anthropic-xml` strict coercion and `antml` schema-validated repairs are intentionally different contracts.
- Protocol implementations include both batch parsing and incremental `feed`/`finish`; keep terminal truncation consistent with the format's incomplete-call rules.
- `xml` maps to the Morph XML implementation for compatibility; new format integrations use `morph-xml`.

## ANTI-PATTERNS

- Treating the outer recovery wrapper as the place to repair protocol-specific argument syntax.
- Assuming Gemma or Kimi delimiters have XML nesting semantics.
- Recognizing nested protocol-looking text inside an argument value as a new executable call.
- Updating batch parsing without checking incremental splits and end-of-stream behavior.

## VALIDATION

- Parser and stream suites are flat under `packages/ai/test/tool-call-middleware/`, not nested to mirror this directory.
- `stream-integration.test.ts` and `truncation-e2e.test.ts` exercise the shared cross-protocol contract.
