// Command qaharness is the manual-QA driver for the extension-UI bridge dialogs
// and the /login /logout dialogs (plan task 13). It renders a chosen scene to
// stdout at a chosen width and color profile so a tmux pane can capture it
// (tmux capture-pane -e) and the xterm.js harness can extract the cell grid for
// assertions.
//
// Scenes:
//
//	login          - /login provider list with ✓ configured / env status
//	                 indicators (OAuthSelectorComponent parity).
//	login-flow     - the login flow view after login_start, rendering the auth
//	                 URL delivered by an auth_login_url event.
//	login-error    - the login flow view after a failed auth_login_end.
//	logout         - /logout provider list (stored-credential rows).
//	select         - a select extension_ui_request rendered as a fuzzy list.
//	confirm        - a confirm extension_ui_request.
//	input          - an input extension_ui_request.
//	editor         - an editor extension_ui_request (multiline, prefilled).
//
// It is NOT a package test; it is invoked by hand during QA.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/extui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

func main() {
	scene := flag.String("scene", "login", "scene name")
	width := flag.Int("width", 100, "render width in columns")
	profileName := flag.String("profile", "truecolor", "color profile: truecolor|ansi256|ansi|nocolor")
	flag.Parse()

	profile, err := theme.ProfileFromName(*profileName)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad profile:", err)
		os.Exit(2)
	}
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	if err != nil {
		fmt.Fprintln(os.Stderr, "theme load:", err)
		os.Exit(1)
	}
	km := keybindings.NewManager(nil)
	deps := extui.Deps{Theme: th, Keybindings: km}

	var lines []string
	switch *scene {
	case "login":
		lines = extui.NewLoginDialog(loginOpts(th, km, "login")).Render(*width)
	case "logout":
		lines = extui.NewLoginDialog(loginOpts(th, km, "logout")).Render(*width)
	case "login-flow":
		d := extui.NewLoginDialog(loginOpts(th, km, "login"))
		d.HandleInput("\r")
		d.OnAuthURL("anthropic", "https://claude.ai/oauth/authorize?code=STUB")
		lines = d.Render(*width)
	case "login-error":
		d := extui.NewLoginDialog(loginOpts(th, km, "login"))
		d.HandleInput("\r")
		d.OnAuthURL("anthropic", "https://claude.ai/oauth/authorize?code=STUB")
		d.OnAuthEnd("anthropic", false, "address already in use")
		lines = d.Render(*width)
	case "select":
		d, _ := extui.DialogForRequest(request("select", map[string]any{
			"title": "Choose a branch", "options": []any{"main", "develop", "feature/auth"},
		}), deps)
		lines = d.Render(*width)
	case "confirm":
		d, _ := extui.DialogForRequest(request("confirm", map[string]any{
			"title": "Apply changes?", "message": "This will overwrite 3 files.",
		}), deps)
		lines = d.Render(*width)
	case "input":
		d, _ := extui.DialogForRequest(request("input", map[string]any{
			"title": "Commit message", "placeholder": "describe the change",
		}), deps)
		lines = d.Render(*width)
	case "editor":
		d, _ := extui.DialogForRequest(request("editor", map[string]any{
			"title": "Edit note", "prefill": "line one\nline two",
		}), deps)
		lines = d.Render(*width)
	default:
		fmt.Fprintln(os.Stderr, "unknown scene:", *scene)
		os.Exit(2)
	}

	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = theme.RenderAtRaw(profile, l)
	}
	fmt.Print(strings.Join(out, "\r\n"))
	fmt.Print("\r\n")
}

func request(method string, fields map[string]any) bridge.ExtensionUIRequest {
	return bridge.ExtensionUIRequest{Type: "extension_ui_request", ID: "req-qa", Method: method, Fields: fields}
}

func loginOpts(th *theme.Theme, km *keybindings.Manager, mode string) extui.LoginOptions {
	providers := []bridge.AuthProvider{
		{ID: "anthropic", Name: "Anthropic", AuthType: "oauth", Status: bridge.AuthStatus{Configured: true, Source: "stored"}},
		{ID: "openai", Name: "OpenAI", AuthType: "api_key", Status: bridge.AuthStatus{Configured: false, Source: "environment", Label: "OPENAI_API_KEY"}},
		{ID: "google", Name: "Google Gemini", AuthType: "api_key", Status: bridge.AuthStatus{Configured: false}},
	}
	if mode == "logout" {
		providers = []bridge.AuthProvider{
			{ID: "anthropic", Name: "Anthropic", AuthType: "oauth", Status: bridge.AuthStatus{Configured: true, Source: "stored"}},
			{ID: "openai", Name: "OpenAI", AuthType: "api_key", Status: bridge.AuthStatus{Configured: true, Source: "stored"}},
		}
	}
	return extui.LoginOptions{Mode: mode, Theme: th, Keybindings: km, Providers: providers}
}
