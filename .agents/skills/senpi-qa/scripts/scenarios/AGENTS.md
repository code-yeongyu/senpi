# QA Regression Scenarios

## OVERVIEW

Issue-focused real-CLI runners and their wire/setup fixtures; score 9, a distinct regression domain with 31 direct runners and six nested helper files.

## WHERE TO LOOK

| Regression surface | Starting point |
|---|---|
| Anthropic fallback after partial output | `anthropic-mid-output-fallback-qa.mjs` |
| Compaction budgets, retry sharing and aborts | `compaction-absolute-cap-qa.mjs`, `compaction-shared-retry-qa.mjs`, `compaction-abort-standdown-qa.mjs` |
| Cached goals across RPC and terminal | `cache-warm-ready-rpc-tui.mjs` -> `../lib/cache-warm-ready-scenario.mjs` |
| Reload/warmup lifecycle | `goal-reload-reengagement-qa.mjs`, `reload-stale-warmup-crash-qa.mjs` |
| RPC malformed input / fast-mode state | `rpc-input-hardening-qa.mjs`, `rpc-fast-mode-surface-qa.mjs` |
| Eval execution signals / throughput UI | `eval-execution-event-qa.mjs`, `eval-throughput-badge-qa.mjs` |
| Dollar skill/extension invocation | `dollar-skill-invocation-qa.mjs`, `dollar-invocation-qa.mjs` |
| Per-model thinking state | `per-model-thinking-memory-qa.mjs` |
| Cursor exec bridge lifecycle | `cursor-exec-lifecycle-qa.mjs` and `cursor-exec-lifecycle/` |
| Cursor import and post-login model catalog | `cursor-oauth-catalog-refresh-qa.mjs` and `cursor-oauth-catalog-refresh/setup.ts` |
| Credentialed Cursor CLI lane | `cursor-cli-oauth-qa.mjs` (`SENPI_CURSOR_CLI_LIVE=1`) |

## CONVENTIONS

- These are directly invoked programs, not tests discovered by a workspace runner; many have top-level execution and no `--self-test` parser.
- Fixtures may register temporary extensions, HTTP/SSE servers or sandbox settings to reach a specific real session path.
- `anthropic-mid-output-fallback-qa.mjs` runs both abort-server-fallback settings, checks primary/fallback request order and proves abandoned tools never execute.
- That scenario also resumes the saved session, rejects fallback markers in replayed model input and records cleanup assertions.
- Its evidence slug is fixed to `anthropic-mid-output-wire`; no `--evidence` argument is consumed.
- Cursor lifecycle `wire.mjs` loads the real generated protobuf schemas via `tsx/esm/api`; sibling modules separate frames, server playback and CLI turns.
- Catalog-refresh `setup.ts` is a source-loaded helper, not a standalone Node script; it observes import refresh and the interactive post-login catalog/render path.
- `cursor-cli-oauth-qa.mjs` is credentialed opt-in QA, not proof that all `-qa` files are hermetic.

## COMMANDS

Run from the repository root; the focused regression owns its argument and evidence contract.

```bash
node .agents/skills/senpi-qa/scripts/scenarios/anthropic-mid-output-fallback-qa.mjs
node .agents/skills/senpi-qa/scripts/scenarios/rpc-input-hardening-qa.mjs --evidence rpc-input-hardening
```

## ANTI-PATTERNS

- Do not import a top-level scenario merely to reuse a fixture; shared behavior belongs in `../lib/` or its existing scenario helper directory.
- Do not collapse the mid-output fallback scenario into a fake successful response: abandoned tool execution and replay sanitization are part of its proof.
- Do not use a successful reproduction run as an assertion suite; `-repro` runners have their own observational contract.
- Do not replace the catalog helper's real `ModelRuntime` login/refresh path with a static model-list assertion.
