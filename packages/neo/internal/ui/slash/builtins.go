package slash

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
)

// Handler is a builtin slash command: its name/description (mirrored from
// BUILTIN_SLASH_COMMANDS) plus a Handle func that classifies a submitted line
// into a typed Action. Handle receives the FULL submitted text (e.g.
// "/export dump.jsonl") so argument-bearing commands can parse their tail —
// exactly as interactive-mode.ts onSubmit does.
type Handler struct {
	Name        string
	Description string
	Handle      func(text string) Action
}

// Builtins is the ordered registry of the 22 builtin slash commands. Order is
// the BUILTIN_SLASH_COMMANDS order (slash-commands.ts:18-41), which the merge
// step preserves as the leading autocomplete bucket.
type Builtins struct {
	order  []string
	byName map[string]Handler
}

// builtinSpec mirrors slash-commands.ts BUILTIN_SLASH_COMMANDS verbatim (name +
// description), in source order. The App name in the /quit description is
// resolved at runtime by classic; neo uses the literal product name for parity.
var builtinSpec = []struct {
	name string
	desc string
}{
	{"settings", "Open settings menu"},
	{"model", "Select model (opens selector UI)"},
	{"favorite-models", "Manage favorite models for Ctrl+P cycling"},
	{"export", "Export session (HTML default, or specify path: .html/.jsonl)"},
	{"import", "Import and resume a session from a JSONL file"},
	{"share", "Share session as a secret GitHub gist"},
	{"copy", "Copy last agent message to clipboard"},
	{"name", "Set session display name"},
	{"session", "Show session info and stats"},
	{"changelog", "Show changelog entries"},
	{"hotkeys", "Show all keyboard shortcuts"},
	{"fork", "Create a new fork from a previous user message"},
	{"clone", "Duplicate the current session at the current position"},
	{"tree", "Navigate session tree (switch branches)"},
	{"trust", "Save project trust decision for future sessions"},
	{"login", "Configure provider authentication"},
	{"logout", "Remove provider authentication"},
	{"new", "Start a new session"},
	{"compact", "Manually compact the session context"},
	{"resume", "Resume a different session"},
	{"reload", "Reload keybindings, extensions, skills, prompts, and themes"},
	{"quit", "Quit senpi"},
}

// NewBuiltins builds the registry. Every builtin gets a concrete handler; there
// are no TODO stubs (the acceptance test enforces this).
func NewBuiltins() *Builtins {
	b := &Builtins{byName: make(map[string]Handler, len(builtinSpec))}
	for _, s := range builtinSpec {
		b.order = append(b.order, s.name)
		b.byName[s.name] = Handler{Name: s.name, Description: s.desc, Handle: handlerFor(s.name)}
	}
	return b
}

// Lookup returns the handler for a builtin name.
func (b *Builtins) Lookup(name string) (Handler, bool) {
	h, ok := b.byName[name]
	return h, ok
}

// Has reports whether name is a builtin.
func (b *Builtins) Has(name string) bool {
	_, ok := b.byName[name]
	return ok
}

// Names returns the builtin names in registry (source) order.
func (b *Builtins) Names() []string {
	return append([]string(nil), b.order...)
}

// BuiltinNames is a convenience returning the canonical builtin order.
func BuiltinNames() []string { return NewBuiltins().Names() }

// overlay returns an ActionOpenOverlay for the given kind.
func overlay(k OverlayKind) Action { return Action{Kind: ActionOpenOverlay, Overlay: k} }

// rpc returns an ActionRPC for the given command type with optional fields.
func rpc(cmdType string, fields map[string]any) Action {
	return Action{Kind: ActionRPC, Command: bridge.Command{Type: cmdType, Fields: fields}}
}

// native returns an ActionNative for the given kind.
func native(k NativeKind) Action { return Action{Kind: ActionNative, Native: k} }

// commandTail returns the argument text after "/<name>" (trimmed), or "" when
// the line is exactly the command. Mirrors the classic slice()/trim() parsing.
func commandTail(text, name string) string {
	prefix := "/" + name
	trimmed := strings.TrimSpace(text)
	if trimmed == prefix {
		return ""
	}
	if strings.HasPrefix(trimmed, prefix+" ") {
		return strings.TrimSpace(trimmed[len(prefix)+1:])
	}
	return ""
}

// handlerFor returns the Handle func for a builtin, encoding the classic
// interactive-mode.ts:2918-3044 routing plus the plan task 11 RPC/native map.
func handlerFor(name string) func(string) Action {
	switch name {
	// --- Overlays (task 12) ---
	case "settings":
		return func(string) Action { return overlay(OverlaySettings) }
	case "model":
		return func(text string) Action {
			a := overlay(OverlayModel)
			a.Arg = commandTail(text, "model") // optional search term
			return a
		}
	case "favorite-models":
		return func(string) Action { return overlay(OverlayFavoriteModels) }
	case "fork":
		return func(string) Action { return overlay(OverlayUserMessage) }
	case "tree":
		return func(string) Action { return overlay(OverlayTree) }
	case "trust":
		return func(string) Action { return overlay(OverlayTrust) }
	case "login":
		return func(string) Action { return overlay(OverlayLogin) }
	case "logout":
		return func(string) Action { return overlay(OverlayLogout) }
	case "resume":
		return func(string) Action { return overlay(OverlaySession) }
	case "hotkeys":
		return func(string) Action { return overlay(OverlayHotkeys) }

	// --- RPC / native ---
	case "export":
		return func(text string) Action {
			arg := commandTail(text, "export")
			if strings.HasSuffix(arg, ".jsonl") {
				a := native(NativeExportJsonl)
				a.Arg = arg
				return a
			}
			fields := map[string]any(nil)
			if arg != "" {
				fields = map[string]any{"outputPath": arg}
			}
			return rpc("export_html", fields)
		}
	case "import":
		return func(text string) Action {
			// Confirm-then-switch: primary is switch_session; confirm is the
			// pre-step. The dispatcher/app runs NativeImportConfirm first.
			a := rpc("switch_session", nil)
			a.Arg = commandTail(text, "import")
			a.Follow = NativeImportConfirm
			return a
		}
	case "share":
		return func(string) Action {
			// export_html to a temp file, then gh gist create (native follow).
			a := rpc("export_html", nil)
			a.Follow = NativeShareGist
			return a
		}
	case "copy":
		return func(string) Action {
			// get_last_assistant_text, then OS clipboard write (native follow).
			a := rpc("get_last_assistant_text", nil)
			a.Follow = NativeCopyClipboard
			return a
		}
	case "name":
		return func(text string) Action {
			arg := commandTail(text, "name")
			return rpc("set_session_name", map[string]any{"name": arg})
		}
	case "session":
		return func(string) Action { return rpc("get_session_stats", nil) }
	case "changelog":
		return func(string) Action { return native(NativeChangelog) }
	case "clone":
		return func(string) Action { return rpc("clone", nil) }
	case "new":
		return func(string) Action { return rpc("new_session", nil) }
	case "compact":
		return func(text string) Action {
			arg := commandTail(text, "compact")
			fields := map[string]any(nil)
			if arg != "" {
				fields = map[string]any{"customInstructions": arg}
			}
			return rpc("compact", fields)
		}
	case "reload":
		return func(string) Action { return native(NativeReload) }
	case "quit":
		return func(string) Action { return native(NativeQuit) }
	}
	// Unreachable: every builtin is handled above. Returning ActionNone here
	// would be caught by the acceptance test.
	return func(string) Action { return Action{Kind: ActionNone} }
}
