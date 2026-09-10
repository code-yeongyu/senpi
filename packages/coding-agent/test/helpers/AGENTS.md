# test/helpers

## OVERVIEW

Shared subprocess, provider, compaction, and UI fixtures. Score 9 - distinct cross-suite harness domain; AST inspection finds 34 references to `createInMemoryExtensionSessionSettings`.

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Fake Anthropic-compatible HTTP model | `rpc-fake-model.ts` - `startFakeModelServer`, request capture, mock provider/model IDs |
| CLI RPC session + models.json | `rpc-hermetic.ts` - `startHermeticRpcSession`, `hermeticProviderEnv`, `writeRpcModelsJson` |
| Child exit and root cleanup | `process-teardown.ts` - `teardownChildProcessesAndRoots` |
| Localhost QA listener | `qa-port.ts` - `listenOnQaPort`, `qaPortsFrom`, `QaPort` |
| In-memory extension settings | `extension-session-settings.ts` - facade backed by `SettingsManager.inMemory`, `HARD_LIMIT_SETTINGS` |
| Blocking compaction extension context | `blocking-compaction-harness.ts` |
| Scripted Claude SDK query / account lane | `claude-sdk-oauth-scripted-sdk.ts` |
| Claude resident restart fixtures | `claude-sdk-oauth-restart-fixture.ts`, `claude-sdk-oauth-local-probe.ts` |
| ESM import-graph probes | `esm-import-graph-probe.ts` |
| Stream reveal / footer rendering | `streaming-reveal.ts`, `footer-test-fixtures.ts` |

## CONVENTIONS

- Helpers export directly from individual files; no barrel owns this fixture surface.
- `hermeticProviderEnv` blanks its explicit provider-key list. It does not scrub branded agent/package directory overrides; that separate contract is in the parent guide.
- `startHermeticRpcSession` writes a fake-model catalog and launches the source CLI through `RpcClient`; its `close` stops the client, closes the fake server, then removes session state.
- `teardownChildProcessesAndRoots` consumes its input arrays, sends TERM, awaits exit, escalates to KILL on the bounded deadline, and removes roots only after children exit.
- Cooperative children can supply `awaitTermAcknowledged`; register acknowledgement observation before triggering teardown so the exit deadline does not race cleanup side effects.
- `listenOnQaPort` binds loopback using the typed 18990-18999 fallback set and reports every failed candidate if exhausted.
- `HARD_LIMIT_SETTINGS.toolAdmissionEnabled = false` deliberately pins the pre-admission blocking-compaction path; changing it changes the test seam.

## ANTI-PATTERNS

- `rpc-hermetic.ts` still has a 200ms `waitForSessionWrites` sleep. It is legacy reliability debt, not a persistence-completion signal to reuse in new tests.
- Do not remove roots while a child can still write into them or bypass teardown's post-KILL failure.
- Do not replace the in-memory settings facade with inert setters: tests depend on updates and flushes reaching the backing SettingsManager.
- Do not turn fake-model wire fixtures into full provider mocks when the assertion concerns RPC, stream framing, or child-process behavior.
