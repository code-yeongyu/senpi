## 2026-10-21 - Positive origin metadata on delivered answers (senpi#3888)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/ask-user/tool.ts`: `deliverAnswer` stamps `details: { origin: "ask-user-answer", requestId: request.requestId }` on every non-cancelled later answer, alongside the existing idle follow-up or running steer mode.

### Why

- The desktop consumer (sisyphuslabs/omo-desktop-app#3742) must distinguish engine answer frames from identical text a user typed. The marker stays on the user message in session JSONL and RPC entries; answer text and delivery mode stay unchanged.

### Why an extension could not handle it

- Stamping belongs to this extension, but retaining the metadata requires the core `sendUserMessage` path to copy `details` into immediate and queued user messages.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/builtin/ask-user/tool.ts`, the options passed by `deliverAnswer`.
