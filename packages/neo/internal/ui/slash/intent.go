// Package slash wires the interactive TUI's slash commands, @file-mention and
// bash-mode autocomplete, and the `!` bash execution path. It ports the classic
// interactive-mode.ts dispatch (onSubmit) and the CombinedAutocompleteProvider
// so neo drives the SAME behavior over the existing JSONL RPC via internal/bridge.
//
// Coordination boundary: this package NEVER opens an overlay directly. Builtins
// that classic maps to a picker/modal resolve to a typed OpenOverlay Action
// carrying an OverlayKind. Task 12 (the overlay suite) consumes those intents.
// This keeps the two waves decoupled — slash emits intents; overlays interpret
// them.
package slash

import "github.com/code-yeongyu/senpi/packages/neo/internal/bridge"

// ActionKind classifies what a builtin slash command does when submitted.
type ActionKind int

const (
	// ActionNone is the zero value and signals an unresolved handler (a TODO
	// stub). The acceptance test rejects any builtin that resolves to it.
	ActionNone ActionKind = iota
	// ActionOpenOverlay asks the app shell to open an overlay (task 12). The
	// concrete overlay is carried in Action.Overlay.
	ActionOpenOverlay
	// ActionRPC issues an RPC command over the bridge. The command is in
	// Action.Command.
	ActionRPC
	// ActionNative runs a neo-local action (reads the session store / local
	// resources) with no direct RPC command. The concrete action is in
	// Action.Native.
	ActionNative
)

// OverlayKind is the typed target of an ActionOpenOverlay intent. The values
// mirror the classic interactive-mode.ts overlay openers (show*Selector /
// handle*Command). Task 12 owns the rendering; this package owns the mapping.
type OverlayKind int

const (
	OverlayNone OverlayKind = iota
	OverlaySettings
	OverlayModel
	OverlayFavoriteModels
	OverlaySession     // /resume — session picker
	OverlayTree        // /tree — session tree navigator
	OverlayTrust       // /trust — trust selector
	OverlayLogin       // /login — OAuth selector (login mode)
	OverlayLogout      // /logout — OAuth selector (logout mode)
	OverlayHotkeys     // /hotkeys — keybinding registry view
	OverlayUserMessage // /fork — user-message selector
)

// NativeKind is the typed target of an ActionNative intent — actions with no
// dedicated RPC command that neo performs locally (reading the session store or
// local resources) or that end the process.
type NativeKind int

const (
	NativeNone          NativeKind = iota
	NativeChangelog                // /changelog — parse local CHANGELOG
	NativeReload                   // /reload — reload keybindings/extensions/skills/prompts/themes
	NativeQuit                     // /quit — shut down
	NativeExportJsonl              // /export <path>.jsonl — native jsonl export via session store
	NativeCopyClipboard            // paired with get_last_assistant_text: OS clipboard write
	NativeShareGist                // paired with export_html: gh gist create
	NativeImportConfirm            // paired with switch_session: confirm + import from jsonl
)

// Action is the resolved outcome of dispatching a builtin slash command.
type Action struct {
	Kind    ActionKind
	Overlay OverlayKind
	Native  NativeKind
	// Command is the RPC command to issue for ActionRPC (and the primary command
	// for composite actions like /copy = get_last_assistant_text + clipboard).
	Command bridge.Command
	// Arg carries the parsed command argument (e.g. the jsonl path for
	// /export dump.jsonl, or the import source path).
	Arg string
	// Follow is an optional post-primary native step for composite actions:
	// /copy → get_last_assistant_text then NativeCopyClipboard;
	// /share → export_html then NativeShareGist;
	// /import → confirm (NativeImportConfirm) then switch_session.
	Follow NativeKind
}
