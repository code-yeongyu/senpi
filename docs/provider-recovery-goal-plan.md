This temporary goal/plan document records execution criteria in git history. It will be deleted in the final cleanup commit.

# Provider/session recovery hardening goal and plan

## Goal

Make persisted senpi sessions recover from malformed OpenAI Chat Completions-compatible tool histories before those histories reach the provider and cause repeated HTTP 400 invalid-request failures.

## Non-goals

- Do not change the agent main loop.
- Do not change `packages/ai` shared message conversion semantics in this task.
- Do not add generic retry for all HTTP 400 responses.
- Do not add new user-facing commands or settings.

## Implementation plan

1. Add `sanitize-openai-completions-payload.ts` under `packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/`.
2. The sanitizer accepts unknown payloads and only handles Chat Completions-style `{ messages: unknown[] }` payloads.
3. It tracks assistant `tool_calls[].id` values and corresponding `role: "tool"` messages.
4. It removes orphan or duplicate `role: "tool"` messages.
5. It inserts synthetic `role: "tool"` messages for assistant tool calls that have no matching result before the next assistant/user/non-tool item advances the transcript.
6. Wire the sanitizer into `tool-pair-guard/index.ts` after Anthropic and OpenAI Responses sanitization.
7. Add focused unit tests under `packages/coding-agent/test/tool-pair-guard/`.
8. Update `packages/coding-agent/src/core/extensions/changes.md` and `packages/coding-agent/CHANGELOG.md`.
9. Verify with LSP, TypeScript no-excuse checker, targeted tests, `npm run check`, and manual QA.

## Manual QA plan

1. Run a small Node/tsx driver that imports the new sanitizer and passes a malformed Chat Completions payload containing an orphan `role: "tool"` message. Expected output: sanitized message count excludes the orphan.
2. Run an HTTP-server scenario in tmux that exposes the sanitizer through a tiny temporary local script, send malformed JSON by `curl`, and observe valid sanitized JSON in response.
3. Clean all temporary scripts, tmux sessions, and debug artifacts after QA.

## Pass/fail acceptance criteria

- PASS if all valid Chat Completions tool pairs are unchanged by reference.
- PASS if orphan Chat Completions tool messages are removed.
- PASS if interrupted assistant tool calls get synthetic tool results.
- PASS if `tool-pair-guard` still sanitizes Anthropic and OpenAI Responses payloads.
- PASS if the targeted tool-pair guard tests exit 0 from `packages/coding-agent`.
- PASS if `npm run check` exits 0 from repo root.
- PASS if manual QA observes corrected output through the actual exported sanitizer module.
