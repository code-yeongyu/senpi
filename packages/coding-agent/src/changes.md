# changes

## Wave 2 app-server parity verifier corrections (2026-07-20)

### What changed

- `modes/app-server/protocol/`: corrected fuzzy-search result keys to Codex's snake-case wire names and completed the
  handwritten thread-item/history facade so runtime modules no longer import generated protocol files directly.
- `modes/app-server/threads/`: made source-kind parsing strict, separated user-activity recency from general updates,
  persisted unarchive timestamp bumps, rejected non-`u32` history limits, and recorded rejected compactions as failed
  without fabricating a completed item.
- `modes/app-server/server/models.ts`: validates `remoteControl/client/list` parameters before returning the honest
  no-remote-control internal error.
- `test/qa/app-server/`: extended the Todo 8–12 drivers for the rejected edge cases and made the compaction fixture
  exercise explicit manual compaction without being preempted by automatic compaction.

### Why

- Independent parity verification found boundary-validation, persistence, timestamp, import-layer, and failure-path
  mismatches that the first wave's happy-path tests did not distinguish from Codex HEAD behavior.

### Why extension system couldn't handle this

- These contracts are JSON-RPC parsing, thread persistence/projection, and app-server lifecycle behavior below the
  extension boundary.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/` and app-server QA surfaces. Preserve Codex wire names and re-run the focused
  verifier drivers if upstream session timestamp or compaction behavior changes.

## Codex HEAD app-server catalogs, facade, and terminal envelopes (2026-07-20)

### What changed

- `modes/app-server/protocol/`: aligned method catalogs with the pinned Codex HEAD source, added complete experimental
  notification metadata, and added handwritten facade types for the catalog, config, account, collaboration-mode,
  fuzzy-search, thread-parity, terminal-error, and notification-envelope surfaces selected by the parity plan.
- `modes/app-server/server/connection.ts`, `server/notifications.ts`, `rpc/envelope.ts`, `rpc/ndjson.ts`: gate
  experimental notifications from the shared catalog and populate one `emittedAtMs` timestamp per notification before
  fanout, preserving it through final transport serialization while leaving server requests untouched.
- `modes/app-server/server/server-core.ts`: added post-response deferred actions so later thread handlers can guarantee
  response-before-notification ordering.
- `modes/app-server/threads/turns.ts`, `turn-adapter.ts`, `threads/projection.ts`: replaced the fork-only terminal
  `turn/failed` wire event with Codex HEAD's ordered `error` plus failed `turn/completed` pair, sharing one `TurnError`.
- `modes/app-server/server/models.ts`: moved model catalog runtime typing onto the handwritten facade while retaining the
  existing remote-control behavior for its dedicated follow-up task.

### Why

- Codex's generated TypeScript exporter omits experimental request roots and cannot by itself describe the live HEAD
  catalog. Senpi needs a stable, Node-compatible facade derived from both the pinned source inventory and generated
  evidence.
- Current Codex clients expect populated notification timestamps, capability-aware experimental delivery, and terminal
  failures expressed through the canonical error/completion pair.

### Why extension system couldn't handle this

- Method catalogs, transport envelopes, response-frame ordering, and terminal event projection are app-server protocol
  infrastructure that runs outside the coding-agent extension surface.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/` tree. Re-derive catalogs and facade shapes from the new Codex source before
  resolving conflicts; never hand-edit `protocol/generated/**`.

## Neo launch handoff and daemon dispatch (2026-07-06)

### What changed

- `main.ts`: `--neo` / `--neo-isolated` (+ hidden `--neo-bin`) dispatch to the neo Go TUI launcher (`cli/neo/`),
  spawning the per-platform binary with inherited stdio, forwarded signals, and propagated exit code/signal. Dispatch
  sits after the version/export fast-paths and first-time setup, before any `AgentSessionRuntime` construction or
  extension loading, so the launcher stays thin.
- `main.ts`: `--listen <path>` dispatches to the neo daemon supervisor (see `modes/rpc/changes.md` 2026-07-06). The
  `NeoRuntimeOptions` field list is gated by a generated extraction test over `main.ts` `parsed.*` reads, so new
  runtime-relevant flags fail the test until threaded through.

### Why

- The neo TUI is a separate Go binary; senpi remains the single user-facing entrypoint and must hand off cleanly.

### Why extension system couldn't handle this

- Mode dispatch happens in `main()` before extensions load.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `main.ts` mode-dispatch ordering around startup fast-paths.

## App-server mode dispatch (2026-07-02)

### What changed

- `main.ts`: added dispatch for the fork's `senpi app-server` subcommand into `modes/app-server/` (transports,
  daemon supervision, thread lifecycle), hardened on 2026-07-03 with review fixes (entrypoint split, archive-state
  handling). Arg plumbing is in `cli/changes.md`; the mode directory itself does not exist upstream.

### Why

- Codex-compatible app-server clients need a first-class mode entrypoint next to interactive/print/rpc.

### Why extension system couldn't handle this

- Modes are dispatched from `main()` before extension loading; a wire-protocol server cannot be an extension.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `main.ts` around mode selection and subcommand routing.

## Public model resolution SDK exports (2026-07-02)

### What changed

- `index.ts`: accepted upstream exports for CLI-equivalent model and scoped-model resolution helpers.
- Documentation and examples were updated to describe extension entry renderers and the public SDK surface.

### Why

- External integrations need the same model-resolution behavior the CLI uses without duplicating internal resolver logic.

### Why extension system couldn't handle this

- Public package exports and SDK documentation are package API surfaces. Extensions can consume the exported helpers after
  load, but they cannot publish or document the root module exports themselves.

### Expected merge conflict zones on next upstream sync

- LOW: `index.ts` export list if upstream changes public SDK exports.
- LOW: docs/examples around extension entry renderer examples and model-resolution helper documentation.

## Nested legacy config migration (2026-07-01)

### What changed

- `migrations.ts`: split legacy directory and extension-system migrations into focused modules.
- `legacy-senpi-dir-migration.ts`: migrates missing files from nested legacy `~/.senpi/.pi/agent` and `~/.senpi/.pi/mom` directories into the current senpi config layout without overwriting existing files.

### Why

- Some pre-rename local configs ended up under nested `~/.senpi/.pi/agent`, so a fresh `~/.senpi/agent` could strand custom `models.json` entries such as ccapi-routed Anthropic models.

### Expected merge conflict zones on next upstream sync

- LOW: startup migration orchestration in `migrations.ts`.

## shared provider-native rendering in text output (2026-05-14)

### What changed

- `modes/provider-native-rendering.ts`: added shared provider-native formatting for Anthropic, OpenAI, and Google native web-search metadata, with a generic JSON fallback for unknown provider-native blocks.
- `modes/print-mode.ts`: text print mode now emits provider-native summaries and bodies through the shared formatter instead of silently skipping provider-native content.

### Why

- Native web-search metadata should be readable outside the interactive TUI as well, and the compact rendering rules should stay consistent between interactive and print surfaces.

### Why extension system couldn't handle this

- Print mode emits assistant content directly after the session finishes; extension tool renderers do not own provider-native assistant content.

### Expected merge conflict zones on next upstream sync

- LOW: `modes/print-mode.ts` final assistant-content emission and `modes/provider-native-rendering.ts` if upstream adds its own provider-native formatter.

## CLI export tilde expansion (2026-05-13)

### What changed

- `main.ts`: `senpi --export ~/session.jsonl ~/out.html` expands leading `~` for both the input session path and optional output path before exporting.

### Why

- The interactive `/export` bug also affected the non-interactive export path because Node's path resolution treats `~` as a literal directory name.

### Why extension system couldn't handle this

- `--export` exits before interactive mode and extension command handlers run, so CLI path normalization must happen in `main.ts`.

### Expected merge conflict zones on next upstream sync

- LOW: `main.ts` around the early `parsed.export` branch.

## Senpi self-update release source (2026-05-02)

### What changed

- `config.ts`: Bun-binary self-update fallback now points to `code-yeongyu/senpi` releases.
- `package-manager-cli.ts`: `senpi update senpi` is accepted as the branded self-update target and help text uses senpi wording.
- `package.json`: Repository metadata now points to the senpi fork.

### Why

- Self-update messaging and release metadata should direct users to senpi, not upstream pi-mono.

### Why extension system couldn't handle this

- These are core package metadata and built-in package-command parsing paths that run before extensions participate.

### Expected merge conflict zones on next upstream sync

- LOW: self-update command parsing/help and package metadata.
