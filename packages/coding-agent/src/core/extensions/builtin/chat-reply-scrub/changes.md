# chat-reply-scrub Fork Tracker

## 2026-09-30 - Chat-surface last-mile scrub of finalized replies (senpi#2398)

### What changed

- New fork-only builtin `chat-reply-scrub` (`index.ts`, `scaffold-strip.ts`), registered right after `prompt-preset` in `builtin/index.ts`. Its awaited `message_end` handler runs only when the session's prompt surface (`ctx.getSystemPromptOptions().surface`, else `SENPI_PROMPT_SURFACE`) is `chat`. For assistant messages it rewrites visible text blocks with `stripAgentScaffold` and returns the replacement, which the runner applies before listeners, RPC clients and the session file see the message. Thinking, tool calls and `audience: "model"` text are untouched; a text block that held only scaffolding keeps its slot with empty text (providers skip empty text on replay).
- `stripAgentScaffold` removes a leading routing / stop line (English "I read this as ... I'll stop when ..." and the Korean shapes, with a plan sentence between them), a handoff block (two or more consecutive labelled lines that include an opening label Ask / wanted / For you or the Korean opening labels, or one line carrying the Ask ... - wanted: or For you: ... Now: ... Next: signature), and todo / ledger lines only inside a blank-line-delimited block that also holds a ledger marker (Overall, Remaining items, Active phase) or a removed handoff line. A leading "Name님, " / "@name, " address stays. A reply with nothing to remove comes back byte-identical. Same rules as the OmO gateway's send-boundary strip.
- `test/suite/chat-reply-scrub-extension.test.ts`: the strip cases (Korean, polite Korean and English routing lines; a routing-only reply; a multi-line handoff block; an Overall + checklist block), eight answer texts that must pass unchanged (a requested checklist, a lone Now: / Next: / Todo: line, a Now/Next plan in English and Korean, an ordinary sentence containing 읽었어), block-level scrubbing, and a harness run: a chat-surface session's persisted reply (session entry and session file) loses the routing line; terminal and app replies are untouched.

### Why

- The chat prompt surface stops asking for this scaffolding, but a model can still produce it. The backstop sits on the finalized message so a chat bridge reading the RPC stream or the session receives the clean reply.

### Limits

- Streamed `message_update` deltas are not rewritten; a client that renders deltas live still sees them until the final message replaces them.

### Why an extension could not handle it

- It is an extension; no core file changed.

### Expected merge conflict zones

- Fork-only files. The `chat-reply-scrub` entry in `builtin/index.ts`.
