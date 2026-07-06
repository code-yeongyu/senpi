// Command qaharness is the manual-QA driver for the neo overlay suite (plan
// task 12). It renders a chosen overlay scene to stdout at a chosen width and
// color profile so a tmux pane can capture it (tmux capture-pane -e) and the
// xterm.js harness can extract the cell grid for assertions.
//
// Scenes (one per overlay + failure edges):
//
//	model            - model selector (favorites * marker, current ✓, auth
//	                   indicator, [provider] badge).
//	model-empty      - failure edge: zero models (no-models notice).
//	session          - session picker (named + unnamed rows, sort/filter labels).
//	session-empty    - failure edge: empty sessions dir (no-sessions notice).
//	session-delete   - session picker in delete-confirmation mode.
//	tree             - tree navigator (indented nodes, filter label).
//	settings         - bordered settings modal (▸ cursor, on/off toggles, theme ›).
//	theme            - theme selector ((current) marker).
//	thinking         - thinking-level selector (level descriptions).
//	trust            - trust prompt (saved-decision line, ✓ marks, → selection).
//	hotkeys          - hotkeys view (action -> key from the registry).
//	stats            - session info/stats panel.
//
// It is NOT a package test; it is invoked by hand during QA. Navigation is
// scripted via --select N (0-based highlighted row) where applicable.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

func main() {
	scene := flag.String("scene", "model", "overlay scene name")
	width := flag.Int("width", 120, "render width in columns")
	profileName := flag.String("profile", "truecolor", "color profile: truecolor|ansi256|ansi|nocolor")
	sel := flag.Int("select", 0, "0-based highlighted row (where applicable)")
	flag.Parse()

	profile, err := theme.ProfileFromName(*profileName)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad profile:", err)
		os.Exit(2)
	}

	var lines []string
	switch *scene {
	case "model":
		lines = renderModel(*width, *sel, false)
	case "model-empty":
		lines = renderModel(*width, 0, true)
	case "session":
		lines = renderSession(*width, false, false)
	case "session-empty":
		lines = renderSession(*width, true, false)
	case "session-delete":
		lines = renderSession(*width, false, true)
	case "tree":
		lines = renderTree(*width)
	case "settings":
		lines = renderSettings(*width, *sel)
	case "theme":
		lines = renderTheme(*width)
	case "thinking":
		lines = renderThinking(*width)
	case "trust":
		lines = renderTrust(*width)
	case "hotkeys":
		lines = renderHotkeys(*width)
	case "stats":
		lines = renderStats(*width)
	default:
		fmt.Fprintln(os.Stderr, "unknown scene:", *scene)
		os.Exit(2)
	}

	// Downgrade each truecolor line to the target profile (exact hex at truecolor,
	// palette indices at ansi256/ansi, stripped at nocolor).
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = theme.RenderAtRaw(profile, l)
	}
	fmt.Print(strings.Join(out, "\n"))
	fmt.Print("\n")
}

func renderModel(width, sel int, empty bool) []string {
	models := []overlays.ModelItem{
		{Provider: "openai", ID: "gpt-5", Name: "GPT-5", AuthStatus: overlays.AuthConfigured},
		{Provider: "openai", ID: "gpt-5-mini", Name: "GPT-5 mini", AuthStatus: overlays.AuthConfigured},
		{Provider: "anthropic", ID: "claude-opus", Name: "Claude Opus", AuthStatus: overlays.AuthMissing},
	}
	if empty {
		models = nil
	}
	o := overlays.NewModelSelector(overlays.ModelSelectorOptions{
		Models:       models,
		CurrentModel: "openai/gpt-5",
		Favorites:    overlays.Favorites("openai/gpt-5"),
	})
	kb := keybindings.NewManager(nil)
	for i := 0; i < sel; i++ {
		o.HandleKey("\x1b[B", kb, "")
	}
	return o.RenderStyled(width)
}

func renderSession(width int, empty, deleteMode bool) []string {
	var sessions []store.SessionInfo
	if !empty {
		sessions = []store.SessionInfo{
			{ID: "s1", Path: "/tmp/s1.jsonl", Name: "Refactor auth", FirstMessage: "help me refactor auth"},
			{ID: "s2", Path: "/tmp/s2.jsonl", Name: "", FirstMessage: "what is a monad"},
		}
	}
	o := overlays.NewSessionPicker(overlays.SessionPickerOptions{Sessions: sessions})
	kb := keybindings.NewManager(nil)
	if deleteMode && !empty {
		o.HandleKey("\x04", kb, "") // ctrl+d -> confirmation
	}
	return o.RenderStyled(width)
}

func renderTree(width int) []string {
	root := &overlays.TreeNode{
		ID: "root", Kind: "message", Role: "user", Text: "root question",
		Children: []*overlays.TreeNode{
			{ID: "a1", Kind: "message", Role: "assistant", Text: "assistant reply",
				Children: []*overlays.TreeNode{
					{ID: "u2", Kind: "message", Role: "user", Text: "follow up", Label: "milestone"},
				}},
		},
	}
	o := overlays.NewTreeNavigator(overlays.TreeOptions{Root: root, CurrentLeafID: "u2"})
	return o.RenderStyled(width)
}

func renderSettings(width, sel int) []string {
	o := overlays.NewSettingsModal(overlays.SettingsModalOptions{
		CurrentTheme:    "grok-night",
		AvailableThemes: []string{"grok-night", "grok-day"},
		AutoCompact:     true,
		ShowImages:      true,
	})
	kb := keybindings.NewManager(nil)
	for i := 0; i < sel; i++ {
		o.HandleKey("\x1b[B", kb, "")
	}
	return o.RenderStyled(width)
}

func renderTheme(width int) []string {
	o := overlays.NewThemeSelector("grok-night", []string{"grok-night", "grok-day", "custom-solarized"})
	return o.RenderStyled(width)
}

func renderThinking(width int) []string {
	o := overlays.NewThinkingSelector("medium", []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"})
	return o.RenderStyled(width)
}

func renderTrust(width int) []string {
	saved := &overlays.TrustStoreEntry{Path: "/project", Decision: true}
	o := overlays.NewTrustSelector(overlays.TrustOptions{
		CWD:            "/project",
		SavedDecision:  saved,
		ProjectTrusted: true,
	})
	return o.RenderStyled(width)
}

func renderHotkeys(width int) []string {
	o := overlays.NewHotkeysView(keybindings.NewManager(nil))
	return o.RenderStyled(width)
}

func renderStats(width int) []string {
	o := overlays.NewSessionStats(overlays.SessionStats{
		SessionID:    "sess-2f9a1c",
		SessionName:  "Refactor auth",
		MessageCount: 42,
		InputTokens:  18234,
		OutputTokens: 7650,
		Model:        "openai/gpt-5",
		CWD:          "/Users/me/proj",
	})
	return o.RenderStyled(width)
}
