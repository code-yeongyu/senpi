// Package slash implements the interactive TUI's slash-command system, @file
// mention + bash-mode autocomplete, and the `!` bash execution path for neo
// (plan task 11).
//
// It ports three classic contracts so neo behaves identically over the existing
// JSONL RPC:
//
//   - Builtins (builtins.go): the 22 BUILTIN_SLASH_COMMANDS
//     (slash-commands.ts:18-41) each resolve to a typed Action — an OpenOverlay
//     intent (task 12 renders it), an RPC command (internal/bridge), or a native
//     local action. The mapping is complete and asserted (no TODO stubs).
//   - Autocomplete (autocomplete.go, filewalk.go, slashfilter.go): a port of
//     CombinedAutocompleteProvider (autocomplete.ts) implementing the wave-1
//     editor's AutocompleteProvider + CtxAutocompleteProvider + file-completion
//     gate. Slash-command filtering matches getSlashCommandSuggestions; @file
//     mentions use the fd fuzzy walker; plain paths use readdir.
//   - Merge + source tags (commands.go): get_commands responses are merged after
//     the builtins in the classic order builtins → templates → extensions →
//     skills, with [u]/[p]/[t]… source tags per getAutocompleteSourceTag.
//   - Dispatch (dispatch.go) + bash (bash.go): submitted text routes to a
//     builtin action, `!`/`!!` bash (RPC bash/abort_bash + a grok-styled
//     streaming block), a known dynamic command, an unknown-command inline
//     error, or a plain prompt — mirroring interactive-mode.ts onSubmit.
//
// Coordination boundary: this package never opens an overlay directly; it emits
// typed OpenOverlay intents that task 12 consumes.
package slash
