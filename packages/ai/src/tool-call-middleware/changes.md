# Tool Call Middleware Changes

## 2026-08-23 - Kimi XTML sep-less channel marker leak

### What changed and why

- Kimi models leak XTML channel markers into visible text when tool calling
  fails mid-think: session 01a02505 (message 84281a4b, `kimi-k3-ultrafast-unlocked`)
  ended a user-visible text block with the literal `<|close|>think\n` because the
  marker arrives without its trailing `<|sep|>`. Both defenses missed it: the
  stream recovery parser only recognized `<|sep|>`-terminated markers (the
  fallback re-emitted the marker bytes as 2-char text slices), and
  `recoverKimiXtmlThinking()` never scanned `text` blocks at all.
- `markers.ts` now owns a single shared `XTML_CHANNEL_MARKER_PATTERN` consumed by
  BOTH the stream parser and the message-level recovery, so the two paths cannot
  drift again: a marker is `<|open|>`/`<|close|>` + optional channel name
  (`call`/`argument` reserved for structural opens) + optional `<|sep|>`,
  terminated by `<|sep|>`, a non-word character, or end of stream; a bare
  `<|sep|>` is also a marker. `matchXtmlChannelMarker()` anchors it for the
  streaming state machine.
- `recovery-stream.ts` holds a buffer that could still grow into a longer marker
  (name run, partial `<|sep|>`) instead of emitting bytes, defers to structural
  `<|open|>call `/`<|open|>argument ` opens before generic matching, runs behind
  a recovery code mask so fenced/inline code keeps marker-shaped literals, and
  strips held complete markers at `finish()` rather than flushing them.
- `thinking-recovery.ts` additionally strips markers from `text` blocks (same
  code-mask treatment). Text-block stripping is silent: the
  `kimi_xtml_thinking_recovery` diagnostic still fires only for thinking-channel
  recovery, keeping the runtime-boundary diagnostics contract stable.
- A word run after a marker is absorbed into the channel name
  (`<|close|>thinkafter` strips whole), which is the only self-consistent reading
  of the protocol; incomplete junk like `<|clo` still flushes as plain text.

## 2026-08-18 - Wire-alias tool-name resolution in invoke recovery

### What changed and why

- Upstream gateways disguise tool names on the wire: ccapi-cf Pascal-cases
  `todo` to `Todo`, and CC-pool layers expose non-native tools as
  `mcp_<hash>-<Name>` (observed live: `mcp_49f0-Todo`). Reverse mapping only
  rewrites native `tool_use` blocks, so a leaked text invoke keeps the wire
  alias and the recovery resolver vetoed it as an unknown tool, emitting the
  raw XML as literal text (incident: session 01a01381, event 1214,
  `ccapi-clb/claude-opus-5`, stop_reason `tool_use` with zero tool calls).
- `createToolResolver` now falls back to an alias map that strips CC-SDK
  `mcp__server__tool` prefixes, hashed `mcp_<hash>-` prefixes, and collapses
  remaining separators/case onto the registered name's alphanumerics.
- The fallback runs only after exact and case-insensitive matching miss, so
  existing precedence is unchanged. Two registered tools collapsing onto the
  same alias key resolve to neither (mirrors the insensitive-map collision
  rule), keeping hallucinated names as literal text.

## 2026-08-18 - Cursor exec marker preservation

### What changed and why

- Recovery stream snapshots now retain enumerable symbol-keyed metadata on native
  content blocks. This preserves Cursor's `kCursorExecResolved` marker through
  Claude/Kimi model recovery so the agent loop does not execute an already-resolved
  tool call a second time (fixes #938).
- String-keyed snapshot cloning and recovered text-tool behavior are unchanged.

### Why the extension system could not handle this

- The marker must survive the provider-neutral model recovery wrapper before the
  agent loop or extensions consume the assistant stream.

## 2026-08-09 - Claude missing-angle ANTML invoke recovery

### What changed and why

- Claude normal-mode recovery now recognizes the observed transcript shape
  `antml:invoke name="...">` when the opening `<` is missing, including openings
  split at every internal stream boundary.
- The tolerance is intentionally ANTML-specific, exact-case, and boundary-gated.
  Unknown tools, malformed openings, code examples, and non-exact markers remain
  literal text.
- After a successfully recovered missing-angle call, the parser consumes the exact
  stray `</function_results>` trailer observed in the leaked turn plus at most 127
  interstitial whitespace characters. Longer whitespace runs are flushed as text,
  and a standalone or mismatched trailer is preserved.

### Why the extension system could not handle this

- Recovery must transform raw assistant text into a canonical tool call before the
  agent loop persists or renders the assistant message. Extensions only observe the
  already-decoded stream, after this boundary.

### Expected merge conflict zones

- `protocols/antml/recovery-stream.ts`
- `packages/ai/test/tool-call-middleware/claude-invoke-recovery.test.ts`
- `.agents/skills/senpi-qa/scripts/lib/mock-loop-text-leak.mjs`

## 2026-07-30 - Kimi XTML unnamed channel recovery hardening

### What changed and why

- `createXtmlRecoveryStreamParser()` now recognizes an empty channel name in malformed
  `<|open|><|sep|>` / `<|close|><|sep|>` transitions, including markers split at every
  internal stream boundary, instead of leaking them as visible text.
- `recoverKimiXtmlThinking()` now strips `tools`, other valid named channels, and bare
  XTML open/close/sep tokens while preserving the existing response/think state changes
  and code-fenced protocol examples.
- The deterministic Kimi mock-loop fixture includes the observed unnamed-close + tools
  tail so real CLI QA fails if either client recovery layer regresses.

## 2026-07-29 - Kimi XTML leaked tool-call recovery in normal mode

### What changed and why

- `shouldRecoverTextToolCalls()` now defaults on for Kimi-family model ids (boundary regex, mirroring the Claude default), so Kimi models get the same normal-mode auto-correction Claude has when native tool calling misfires into plain text.
- New `createXtmlRecoveryStreamParser()` (`protocols/kimi-xtml/recovery-stream.ts`): recovers leaked `<|open|>tools<|sep|>` blocks into canonical tool calls and strips stray XTML channel-transition markers (think/response/message) from visible text; code-masked spans stay untouched; `interrupt()` restores retained marker fragments as plain text like the invoke parser.
- `wrapStreamWithInvokeRecovery()` and `RecoveryTextProjection` accept an optional recovery-parser factory (default unchanged: ANTML invoke). `ModelRuntime` selects the XTML factory for Kimi models via `hasKimiTextToolCallRecovery()`; Claude and non-Kimi behavior is byte-identical.

### Why the extension system could not handle this

- Recovery must observe raw provider-neutral assistant text before the coding-agent loop executes tools, and the parser selection must happen inside the stream wrapper, ahead of extension-observable events.
## 2026-07-29 - Kimi XTML protocol (Kimi K3 native channel syntax)

### What changed and why

- Added the `kimi-xtml` text-tool protocol: Kimi K3's native XTML channel format (`<|open|>name<|sep|>` / `<|close|>name<|sep|>` markers; tools blocks containing `call` channels with `argument` channels), so Kimi models can serve text-encoded tool calling through a syntax they are already trained on.
- Typed argument coercion: string (default), number, boolean, object/array (strict JSON; malformed values reject the call via `onError` instead of coercing).
- Streaming parser reassembles markers split across chunks, emits snapshot argument deltas per completed argument, and finalizes unterminated calls as `incomplete` with the arguments parsed so far. Unknown tools are skipped with diagnostics.
- Registered in the `ToolCallFormat` union, the `getToolCallFormat()` whitelist, and the protocol registry; compat docs and TESTING.md updated.

### Why the extension system could not handle this

- Text tool-call protocols must intercept and re-encode the provider stream and message history inside the middleware, before coding-agent extensions observe assistant events.
## 2026-07-20 - Claude leaked invoke recovery

### What changed and why

- Added provider-neutral Claude text tool-call recovery for leaked bare or exact lowercase `antml:` invokes, with strict tag/namespace recognition, eager bounded parsing, and validation-gated argument coercion.
- Recovery scans only ordinary assistant text. Inline/fenced code, thinking/redacted thinking, provider-native blocks, native tool calls, and historical messages remain untouched.
- Mixed native/recovered content preserves source order, IDs, signatures, metadata, usage/cost snapshots, and stable partial indices. Native-first ID conflicts are skipped; late collisions and malformed native event order fail closed.
- Complete calls execute through the normal agent loop and persist as native history. Incomplete, invalid, overflowed, aborted, or collided calls remain non-executable and produce redacted diagnostics.
- Parser, code-mask, wrapper, metadata, termination, collision, UTF-16/resource, persistence, and provider replay behavior is covered by focused regression and standalone surface drivers.

### Why the extension system could not handle this

- Recovery must observe raw provider-neutral assistant text before the coding-agent loop executes tools, while preserving per-event partials, provider-native ordering, cancellation, and transport metadata.

## 2026-07-19 - Recovery termination and metadata fidelity

### What changed and why

- Invoke recovery now keeps abort terminals interrupted, strips executable calls from aborted or consumer-cancelled messages, and never converts them into successful `toolUse` turns.
- One terminal path handles done, transport errors, iterator failures, exhaustion, and cancellation after flushing each active text parser exactly once. Dangling recovered calls finalize as incomplete and non-executable.
- Recovery events now snapshot the corresponding source message metadata and complete usage/cost objects, preventing later partial mutations from rewriting previously emitted event metadata. The snapshotter recursively clones enumerable plain objects and arrays with cycle/alias preservation while retaining exotic values by reference.
- Consumer cancellation now awaits upstream iterator cleanup, shares one promise across concurrent returns, and is disabled once a natural terminal or wrapper-owned IteratorClose begins. The legacy text-protocol wrapper remains unchanged.

### Why the extension system could not handle this

- Termination, iterator, partial-message, and usage fidelity are properties of the provider-neutral stream wrapper before coding-agent extensions receive assistant events.

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
