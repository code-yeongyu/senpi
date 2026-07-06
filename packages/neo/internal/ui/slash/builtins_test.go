package slash

import (
	"sort"
	"testing"
)

// builtinNamesFromSpec is the exact set of 22 builtin slash command names from
// packages/coding-agent/src/core/slash-commands.ts:18-41 BUILTIN_SLASH_COMMANDS.
// This list is the acceptance gate: every name here MUST resolve to a handler
// with a concrete Action kind — no TODO stubs. Overlays that task 12 builds map
// to a typed OpenOverlay intent; the mapping must be complete and asserted here.
var builtinNamesFromSpec = []string{
	"settings", "model", "favorite-models", "export", "import", "share",
	"copy", "name", "session", "changelog", "hotkeys", "fork", "clone",
	"tree", "trust", "login", "logout", "new", "compact", "resume",
	"reload", "quit",
}

// TestBuiltinCount asserts the registry mirrors the 22 builtins exactly.
func TestBuiltinCount(t *testing.T) {
	got := BuiltinNames()
	if len(got) != len(builtinNamesFromSpec) {
		t.Fatalf("builtin count = %d, want %d (BUILTIN_SLASH_COMMANDS)", len(got), len(builtinNamesFromSpec))
	}
	sortedGot := append([]string(nil), got...)
	sortedWant := append([]string(nil), builtinNamesFromSpec...)
	sort.Strings(sortedGot)
	sort.Strings(sortedWant)
	for i := range sortedWant {
		if sortedGot[i] != sortedWant[i] {
			t.Fatalf("builtin set mismatch at %d: got %q want %q", i, sortedGot[i], sortedWant[i])
		}
	}
}

// TestEveryBuiltinResolvesToHandler is the core acceptance test: every builtin
// name must map to a handler that produces a concrete, non-stub Action.
func TestEveryBuiltinResolvesToHandler(t *testing.T) {
	reg := NewBuiltins()
	for _, name := range builtinNamesFromSpec {
		t.Run(name, func(t *testing.T) {
			h, ok := reg.Lookup(name)
			if !ok {
				t.Fatalf("builtin %q has no handler", name)
			}
			if h.Name != name {
				t.Fatalf("handler.Name = %q, want %q", h.Name, name)
			}
			if h.Description == "" {
				t.Fatalf("builtin %q has empty description", name)
			}
			act := h.Handle(name)
			if act.Kind == ActionNone {
				t.Fatalf("builtin %q resolved to ActionNone (TODO stub)", name)
			}
			// Each action must carry the concrete target for its kind.
			switch act.Kind {
			case ActionOpenOverlay:
				if act.Overlay == OverlayNone {
					t.Fatalf("builtin %q ActionOpenOverlay has OverlayNone", name)
				}
			case ActionRPC:
				if act.Command.Type == "" {
					t.Fatalf("builtin %q ActionRPC has empty Command.Type", name)
				}
			case ActionNative:
				if act.Native == NativeNone {
					t.Fatalf("builtin %q ActionNative has NativeNone", name)
				}
			default:
				t.Fatalf("builtin %q has unknown Action kind %v", name, act.Kind)
			}
		})
	}
}

// wantMapping pins each builtin to its expected Action classification, derived
// from interactive-mode.ts:2918-3044 (the onSubmit dispatch) and the plan task
// 11 mapping (export_html / get_last_assistant_text+clipboard / native session
// store / overlay-open intents). This is the "mapping must be complete and
// asserted" requirement.
func TestBuiltinMappingClassification(t *testing.T) {
	reg := NewBuiltins()
	type want struct {
		kind    ActionKind
		overlay OverlayKind
		rpcType string
		native  NativeKind
	}
	cases := map[string]want{
		// Overlays (task 12 builds them; here they map to typed open intents).
		"settings":        {kind: ActionOpenOverlay, overlay: OverlaySettings},
		"model":           {kind: ActionOpenOverlay, overlay: OverlayModel},
		"favorite-models": {kind: ActionOpenOverlay, overlay: OverlayFavoriteModels},
		"fork":            {kind: ActionOpenOverlay, overlay: OverlayUserMessage},
		"tree":            {kind: ActionOpenOverlay, overlay: OverlayTree},
		"trust":           {kind: ActionOpenOverlay, overlay: OverlayTrust},
		"login":           {kind: ActionOpenOverlay, overlay: OverlayLogin},
		"logout":          {kind: ActionOpenOverlay, overlay: OverlayLogout},
		"resume":          {kind: ActionOpenOverlay, overlay: OverlaySession},
		"hotkeys":         {kind: ActionOpenOverlay, overlay: OverlayHotkeys},
		// RPC command mappings.
		"export":  {kind: ActionRPC, rpcType: "export_html"},
		"copy":    {kind: ActionRPC, rpcType: "get_last_assistant_text"},
		"share":   {kind: ActionRPC, rpcType: "export_html"},
		"name":    {kind: ActionRPC, rpcType: "set_session_name"},
		"session": {kind: ActionRPC, rpcType: "get_session_stats"},
		"clone":   {kind: ActionRPC, rpcType: "clone"},
		"compact": {kind: ActionRPC, rpcType: "compact"},
		"new":     {kind: ActionRPC, rpcType: "new_session"},
		"import":  {kind: ActionRPC, rpcType: "switch_session"},
		// Native (no RPC command / read local resources).
		"changelog": {kind: ActionNative, native: NativeChangelog},
		"reload":    {kind: ActionNative, native: NativeReload},
		"quit":      {kind: ActionNative, native: NativeQuit},
	}
	for name, w := range cases {
		t.Run(name, func(t *testing.T) {
			h, ok := reg.Lookup(name)
			if !ok {
				t.Fatalf("no handler for %q", name)
			}
			act := h.Handle("/" + name)
			if act.Kind != w.kind {
				t.Fatalf("%q kind = %v, want %v", name, act.Kind, w.kind)
			}
			switch w.kind {
			case ActionOpenOverlay:
				if act.Overlay != w.overlay {
					t.Fatalf("%q overlay = %v, want %v", name, act.Overlay, w.overlay)
				}
			case ActionRPC:
				if act.Command.Type != w.rpcType {
					t.Fatalf("%q rpc type = %q, want %q", name, act.Command.Type, w.rpcType)
				}
			case ActionNative:
				if act.Native != w.native {
					t.Fatalf("%q native = %v, want %v", name, act.Native, w.native)
				}
			}
		})
	}
}

// TestExportJsonlPathRoutesNative asserts /export <path>.jsonl uses the native
// jsonl export (session store) while other /export paths use export_html RPC —
// mirrors handleExportCommand (interactive-mode.ts:5633-5647).
func TestExportPathRouting(t *testing.T) {
	reg := NewBuiltins()
	h, _ := reg.Lookup("export")

	html := h.Handle("/export")
	if html.Kind != ActionRPC || html.Command.Type != "export_html" {
		t.Fatalf("/export (no arg) = %v/%q, want RPC/export_html", html.Kind, html.Command.Type)
	}
	htmlPath := h.Handle("/export out.html")
	if htmlPath.Command.Type != "export_html" || htmlPath.Command.Fields["outputPath"] != "out.html" {
		t.Fatalf("/export out.html outputPath = %v, want out.html", htmlPath.Command.Fields["outputPath"])
	}
	jsonl := h.Handle("/export dump.jsonl")
	if jsonl.Kind != ActionNative || jsonl.Native != NativeExportJsonl {
		t.Fatalf("/export dump.jsonl = %v/%v, want Native/ExportJsonl", jsonl.Kind, jsonl.Native)
	}
	if jsonl.Arg != "dump.jsonl" {
		t.Fatalf("/export dump.jsonl arg = %q, want dump.jsonl", jsonl.Arg)
	}
}

// TestCompactCarriesCustomInstructions asserts /compact <text> passes the
// instructions through (interactive-mode.ts:3009-3013).
func TestCompactCustomInstructions(t *testing.T) {
	reg := NewBuiltins()
	h, _ := reg.Lookup("compact")
	act := h.Handle("/compact focus on the API layer")
	if act.Command.Type != "compact" {
		t.Fatalf("compact type = %q", act.Command.Type)
	}
	if act.Command.Fields["customInstructions"] != "focus on the API layer" {
		t.Fatalf("customInstructions = %v", act.Command.Fields["customInstructions"])
	}
}

// TestNameCarriesArgument asserts /name <n> maps to set_session_name{name}.
func TestNameArgument(t *testing.T) {
	reg := NewBuiltins()
	h, _ := reg.Lookup("name")
	act := h.Handle("/name My Session")
	if act.Command.Type != "set_session_name" {
		t.Fatalf("name type = %q", act.Command.Type)
	}
	if act.Command.Fields["name"] != "My Session" {
		t.Fatalf("name field = %v", act.Command.Fields["name"])
	}
}
