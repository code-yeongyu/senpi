# builtin/hooks

## OVERVIEW
Lifecycle command-hook domain (score 11): layered configuration, explicit command trust, and event-specific result handling.

## WHERE TO LOOK

| Task | File |
|---|---|
| Connect a host event | `index.ts` and the matching adapter |
| Parse supported/unsupported config | `schema.ts`, `handler.ts`, `types.ts` |
| Resolve source precedence | `config-loader.ts`, `plugin-loader.ts`, `plugin-manifest.ts` |
| Match and dispatch handlers | `matcher.ts`, `dispatcher.ts` |
| Spawn a hook process | `command-runner.ts` |
| Trust hashing and persistence | `trust.ts`, `trust-storage.ts`, `trust-state-json.ts` |
| Prompt submission context/blocking | `prompt-adapter.ts` |
| Pre/post tool decisions | `tool-adapter.ts` |
| Session/compaction hooks | `lifecycle-adapter.ts` |
| Stop-hook continuation | `stop-adapter.ts` |
| User command/status UI | `command.ts` |
| Bound and redact output | `output-bounds.ts`, `output-parser.ts`, `safety.ts`, `diagnostics.ts` |

## CONVENTIONS

- `index.ts` exports the extension, config parser, and selected types/constants; adapter APIs remain direct-file imports.
- Source metadata carries scope and load timing; plugin, project, global, and runtime handlers are not interchangeable.
- Project trust state is merged only when the project is trusted; reloading config does not imply approval to execute it.
- Prompt contexts queue for `before_agent_start`; pre-tool contexts are keyed by tool-call ID and consumed by the corresponding result.
- Accepted compactions alone trigger post-compaction handling; rejected compactions do not represent a state change.
- Running-handler status is emitted through the host's tool-hook status callback, not through raw process output.

## ANTI-PATTERNS

- Treating known-but-unsupported event/handler kinds as supported silently.
- Bypassing trust checks, bounded output, or diagnostic redaction while adding an adapter.
- Leaking one tool call's pending context into another call or a later prompt.
- Running the user-prompt hook recursively for extension-originated input.
