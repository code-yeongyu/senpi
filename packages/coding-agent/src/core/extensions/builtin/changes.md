# Builtin extensions changes

## Remove the /sessions session-observer HUD (2026-07-26)

- Deleted the `session-observer/` builtin (11 files: `index`, `loader`, `overlay`, `overlay-format`, `scanner`, `text`, `transcript`, `transcript-entries`, `transcript-format`, `types`) and its three vitest suites (`session-observer-picker`, `session-observer-overlay`, `session-observer-scanner`).
- `builtin/index.ts`: dropped the `sessionObserverExtension` import and the `{ id: "session-observer", factory: sessionObserverExtension }` entry from `builtinExtensions`.
- `core/keybindings.ts`: removed the `app.sessions.observe` keybinding (interface entry, the `ctrl+s` default binding, and the `observeSessions` alias). `ctrl+s` is freed and intentionally not rebound.
- `modes/interactive/interactive-mode.ts`: removed the `app.sessions.observe` -> `/sessions` action handler and the `/hotkeys` row that advertised "Observe session transcripts".
- `AGENTS.md` and the root `README.md` extension table: dropped the `session-observer` row and renumbered the subsequent entries (26 -> 25 in-tree extensions).
- `docs/keybindings.md`: dropped the `app.sessions.observe` row.
- `utils/changes.md`: corrected the stale `shortenPath()` note that claimed it backed the `/sessions` HUD picker; `shortenPath()` itself stays (other consumers remain).
- Neo (the Go TUI) shipped a native port of the same HUD; it was removed in lockstep to satisfy the repo-wide "no /sessions HUD source" contract: `internal/ui/builtinext/{observer,observer_overlay,observer_viewer,observer_test,transcript,transcript_decode,transcript_render}.go`, the `ResolveSessionsCommandOutcome` resolver and its tests, the `app.sessions.observe` keybinding definition/scope/migration/registry-test entries, the qaharness `observer` scenario, the welcome-menu entry that advertised it, the `/sessions` command in the bridge `get_commands` testdata, and the `task-14-session-observer-tail` visual-claims manifest entry plus its triplet.
- Why: user-requested cleanup. The HUD duplicated `/resume`'s session-picking surface and the `ctrl+s` chord collided with the more useful `app.session.toggleSort` / `app.models.save` chords that already bind `ctrl+s` in other scopes.
