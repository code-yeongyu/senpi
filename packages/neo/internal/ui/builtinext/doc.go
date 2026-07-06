// Package builtinext holds native Go reimplementations of the five builtin
// ctx.ui.custom extensions the classic TUI ships:
//
//   - history-search (ctrl+r): cross-session prompt history via a store scan,
//     fuzzy-filtered, insert-on-select. Port of
//     packages/coding-agent/src/core/extensions/builtin/history-search/*.
//   - files browser (/files): files read/written/edited in the active branch,
//     coalesced by path, newest-first. Port of .../builtin/files.ts.
//   - diff viewer (/diff): git status --porcelain parse + picker. Port of
//     .../builtin/diff.ts.
//   - redraws debug (/tui): the TUI full-redraw stat. Port of .../builtin/
//     redraws.ts.
//   - session-observer (ctrl+s): a live transcript HUD that tails a growing
//     session file. Port of .../builtin/session-observer/*.
//
// It also renders the third-party ctx.ui.custom notice dialog. VERIFIED classic
// RPC-mode behavior (rpc-mode.ts:237-241): ctx.ui.custom returns undefined
// synchronously with NO wire message, so there is nothing for a default RPC
// client to render from today. The additive neo-opt-in capability flag and the
// additive extension_ui_request{method:"custom_unsupported"} emission are part
// of task 13 (deferred); this package implements ONLY the Go notice dialog and a
// stub that exercises it from such a request. See notice.go.
//
// Every binding resolves through internal/ui/keybindings (no hardcoded key
// checks). All styling flows through internal/theme (no approximated colors).
package builtinext
