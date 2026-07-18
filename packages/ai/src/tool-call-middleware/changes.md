# Tool Call Middleware Changes

## 2026-07-18 - ANTML protocol with Claude-Code-style failure tolerance

### What changed and why

- Added the `antml` text-tool protocol: the ANTML `<function_calls>`/`<invoke>`/`<parameter>` format
  Anthropic models are post-trained on (see "Better Models: Worse Tools",
  https://lucumr.pocoo.org/2026/7/4/better-models-worse-tools/). Newer Claude models (Opus 4.8,
  Sonnet 5) emit byte-correct tool calls but append invented keys (`requireUnique`, `oldText2`,
  `type`, ...), substitute parameter aliases (`path` for `file_path`, `old_str` for `old_string`),
  and occasionally produce broken `\uXXXX` escapes — slop that Claude Code's own harness absorbs
  silently while strict parsers reject the whole call.
- The protocol shares the invoke scanner/stream machinery with `anthropic-xml` via a new
  `InvokeProtocolConfig` (protocol id, label, tool-call id prefix, coercion strategy);
  `parse.ts`/`stream.ts` in `protocols/anthropic-xml/` were parameterized with zero behavior change
  for the existing format (messages, ids, and event sequences are byte-identical).
- `antml` coercion (`protocols/antml/coerce-parameters.ts`) applies validation-gated repairs:
  case/separator-insensitive property matching, a documented alias table, recursive unknown-key
  filtering honoring `additionalProperties`, `\u` escape repair plus lone-surrogate replacement,
  lenient scalar spellings (`" TRUE "`, `'"2"'`), and duplicate-parameter last-wins. Every repaired
  record must still pass `Value.Check` against the tool schema — repairs only narrow input, never
  invent it, keeping the middleware's strict-parsing contract.
- Formatted output wraps the canonical invoke serialization in `<function_calls>`; input accepts
  both wrapped and bare invokes. Truncation-at-finish recovery inherits the R1-R4 boundary from the
  shared stream core.


## 2026-07-17 - Truncation-recovery boundary for text tool-call protocols

### What changed and why

- The five text-based tool-call protocols (`anthropic-xml`, `hermes`/json-mix, `yaml-xml`,
  `morph-xml`, `gemma4-delimiter`) handled a tool call truncated at stream end inconsistently: some
  parsers silently dropped the partial call, some leaked the raw markup as text, and `morph-xml`
  executed a stale argument snapshot that no longer reflected what the model was writing. There was no
  shared definition of "recoverable" at `finish()`, so the same truncation could be dropped, leaked,
  or executed stale depending on the format.
- Every protocol `finish()` now applies one normative recoverability boundary (R1-R4): the opening
  marker is complete (R1), the tool name resolves against the supplied `tools` (R2), the body is
  structurally complete except for a missing closing marker or a proper prefix of it plus trailing
  whitespace (R3), and the recovered arguments pass `validateToolArguments` against the tool schema
  (R4). A call is recoverable iff all four hold; recoverable calls are ALWAYS force-completed and
  executed exactly like a complete call, with `validateToolArguments` gating every forced completion.
- Unrecoverable calls with a readable, resolving name now emit a terminal `toolcall_end` carrying
  `incomplete: true` and `errorMessage` (plus best-effort parsed arguments) instead of being dropped
  or leaked. Nameless protocol fragments (no readable tool name, so not representable as a `ToolCall`)
  are dropped with a metadata-only `onError` diagnostic (`{ protocol, retainedLength }`). The raw
  truncated fragment is never emitted as text, placed in `onError` metadata, logs, tool results, or
  replayed context — even when `emitRawToolCallTextOnError` is set, for the truncated-at-finish case.
  Mid-stream malformed-COMPLETE-call text-emission policy is unchanged.
- `morph-xml`'s `lastArgumentsSnapshot` fallback is demoted from "execute stale args" to "flagged
  incomplete": a snapshot that no longer matches the live buffer is not what the model was writing
  and must not be executed.
- The `incomplete`/`errorMessage` flags propagate from the parser event through the stream wrapper
  into the agent loop, where a flagged call becomes an immediate error tool result that keeps the
  inner loop alive so the model re-issues the tool call on the next assistant turn (the retry
  contract).
- `"morph-xml"` is the canonical format id; `"xml"` remains as a deprecated alias resolving to the
  same protocol, so persisted `models.json` configs and compiled consumers keep working.

### Why the extension system could not handle this

- The recoverability boundary, per-format `finish()` behavior, the no-raw-fragment guarantee, and the
  `incomplete`-flag propagation all live inside the provider-agnostic tool-call middleware before any
  coding-agent extension participates.

## 2026-04-11

### What changed and why

- Refactor the built-in text-based tool-call protocols toward the `minpeter/ai-sdk-tool-call-middleware` architecture.
- Focus areas:
  - `morph xml` parsing/streaming should stop manufacturing invalid JS values from malformed XML.
  - `hermes` should move toward a shared JSON-mix style parser/stream model.
  - `yaml+xml` support should be added with minimal surface-area changes.

### Progress

- Completed:
  - `morph xml` now rejects malformed `array<object>` payloads instead of coercing them into invalid strings.
  - `hermes` now delegates parsing/streaming to a shared JSON-mix helper so delimiter-based protocols can share logic with less drift.
  - `yaml+xml` support is now wired into the protocol registry with parser/formatter/stream coverage.
  - The stream wrapper now preserves reconstructed outer tool-call/text content across provider-side stream errors instead of falling back to the raw provider message.
  - When a transport error happens after complete tool-call blocks were already recovered, the wrapper now finishes the turn as `toolUse` so the agent can execute those tools instead of dropping the whole turn.

### Files expected to change

- `packages/ai/src/tool-call-middleware/protocols/morph-xml.ts`
- `packages/ai/src/tool-call-middleware/protocols/hermes.ts`
- `packages/ai/src/tool-call-middleware/context-transformer.ts`
- `packages/ai/src/tool-call-middleware/types.ts`
- `packages/ai/src/tool-call-middleware/index.ts`
- `packages/ai/src/tool-call-middleware/stream-wrapper.ts`
- `packages/ai/test/tool-call-middleware/*`

### Why the extension system could not handle this

- The defect is in the provider-agnostic tool-call parsing layer inside `packages/ai`, not in coding-agent UX glue.
- Fixing malformed XML coercion, streaming parser behavior, and protocol registration requires changes to shared core parsing logic.

### Expected merge conflict zones

- `packages/ai/src/tool-call-middleware/protocols/*`
- `packages/ai/src/tool-call-middleware/types.ts`
- `packages/ai/test/tool-call-middleware/*`

## 2026-07-14 - Anthropic legacy XML tool-call protocol

### What changed and why

- Added the `anthropic-xml` text-tool protocol for OpenAI-compatible models that emit legacy Anthropic-style
  `<invoke name="..."><parameter name="...">...</parameter></invoke>` calls.
- Registered the format in the middleware protocol registry, compatibility whitelist, and coding-agent custom-model schema.
- Added batch, streaming, resource-bound, formatter, coercion, registration, and faux-provider end-to-end coverage.

### Why the extension system could not handle this

- Text-tool parsing and custom-model format validation happen in shared AI and coding-agent core before extension tool execution.
