# packages/ai/src/tool-call-middleware/protocols/kimi-xtml

Generated: 2026-09-10. Commit `2d0fa41c5`.

## OVERVIEW

Kimi XTML channel parsing, leaked-call recovery, and thinking-to-response projection. Score 8: exported channel-specific state machines and recovery boundary.

## WHERE TO LOOK

| Task | File |
|---|---|
| Structural tokens, channel markers, partial suffixes | `markers.ts` |
| Batch calls and typed argument values | `parse.ts` |
| Incremental tools/call/argument modes | `stream.ts` |
| Tool/system/result formatting | `format.ts` |
| Leaked XTML call parser | `recovery-stream.ts` |
| Repair a completed message's thinking channels | `thinking-recovery.ts` |
| Project thinking recovery through stream events | `thinking-recovery-stream.ts` |

## CONVENTIONS

- Structural call/argument markers include attributes and a separator; bare channel-marker stripping must not consume their contents as ordinary channel noise.
- Incremental modes distinguish text, tools, call headers/body, argument headers/value, and discarded calls.
- Unknown tools enter discard mode; a recognized call starts only after its complete header has been parsed.
- Argument deltas carry the accumulated argument object; preserve this format when changing chunk handling.
- `finish()` flushes ordinary trailing text, but an active unfinished call ends with `incomplete` rather than successful execution.
- Thinking recovery starts in the thinking channel; an opened response channel moves content to visible text, and closing it returns to thinking.
- Code-masked segments remain literal during channel cleanup; examples in fenced code must not trigger projection.
- Unchanged completed messages retain their identity. Changed thinking adds a `kimi_xtml_thinking_recovery` diagnostic with whether response content was recovered.

## ANTI-PATTERNS

- Treating XTML as angle-bracket XML or stripping every `<|open|>` substring without channel context.
- Letting invalid argument coercion end as a complete successful call.
- Combining completed-message repair and streamed event projection without checking event/content index consistency.
- Dropping valid text around split channel markers when retaining a partial suffix.

## VALIDATION

- Use `kimi-xtml-{parser,stream,marker-leak,thinking-recovery,recovery-stream,recovery-activation}.test.ts` under the middleware test directory.
- Activation tests cover the model selector outside this directory; parser changes alone do not establish recovery eligibility.
