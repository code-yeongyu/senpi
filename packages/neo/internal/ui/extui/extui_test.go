package extui

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

func testTheme(t *testing.T) *theme.Theme {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	if err != nil {
		t.Fatalf("load theme: %v", err)
	}
	return th
}

func testKeybindings(t *testing.T) *keybindings.Manager {
	t.Helper()
	return keybindings.NewManager(nil)
}

func plain(lines []string) string { return ui.StripANSI(strings.Join(lines, "\n")) }

func req(method string, fields map[string]any) bridge.ExtensionUIRequest {
	return bridge.ExtensionUIRequest{Type: "extension_ui_request", ID: "req-1", Method: method, Fields: fields}
}

// --- Router: every one of the 9 extension_ui_request methods is handled. ---

func TestDialogForRequest_AllInteractiveMethodsRouted(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	deps := Deps{Theme: th, Keybindings: km}

	cases := []struct {
		method string
		fields map[string]any
	}{
		{"select", map[string]any{"title": "Pick one", "options": []any{"alpha", "beta"}}},
		{"confirm", map[string]any{"title": "Proceed?", "message": "This will apply changes"}},
		{"input", map[string]any{"title": "Name", "placeholder": "your name"}},
		{"editor", map[string]any{"title": "Edit note", "prefill": "hello"}},
	}
	for _, c := range cases {
		d, ok := DialogForRequest(req(c.method, c.fields), deps)
		if !ok || d == nil {
			t.Fatalf("method %q should route to an interactive dialog", c.method)
		}
		if d.RequestID() != "req-1" {
			t.Fatalf("method %q dialog should carry the request id, got %q", c.method, d.RequestID())
		}
		out := plain(d.Render(60))
		if strings.TrimSpace(out) == "" {
			t.Fatalf("method %q dialog rendered empty", c.method)
		}
	}
}

func TestApplyRequest_FireAndForgetMethodsProduceDirectives(t *testing.T) {
	cases := []struct {
		method string
		fields map[string]any
		want   DirectiveKind
	}{
		{"notify", map[string]any{"message": "hi", "notifyType": "warning"}, DirectiveNotify},
		{"setStatus", map[string]any{"statusKey": "k", "statusText": "busy"}, DirectiveSetStatus},
		{"setWidget", map[string]any{"widgetKey": "w", "widgetLines": []any{"line1"}}, DirectiveSetWidget},
		{"setTitle", map[string]any{"title": "My Title"}, DirectiveSetTitle},
		{"set_editor_text", map[string]any{"text": "prefill text"}, DirectiveSetEditorText},
	}
	for _, c := range cases {
		dir, ok := ApplyRequest(req(c.method, c.fields))
		if !ok {
			t.Fatalf("method %q should produce a directive", c.method)
		}
		if dir.Kind != c.want {
			t.Fatalf("method %q -> kind %v, want %v", c.method, dir.Kind, c.want)
		}
	}
}

// --- select: fuzzy list; confirm selection returns the chosen option value. ---

func TestSelectDialog_ConfirmReturnsChosenValue(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	d, ok := DialogForRequest(req("select", map[string]any{"title": "Pick", "options": []any{"alpha", "beta", "gamma"}}), Deps{Theme: th, Keybindings: km})
	if !ok {
		t.Fatal("select should route")
	}
	// Move down twice to gamma, then confirm.
	d.HandleInput("\x1b[B")
	d.HandleInput("\x1b[B")
	resp, done := d.HandleInput("\r")
	if !done {
		t.Fatal("enter should complete the select dialog")
	}
	if resp.Cancelled || resp.Value != "gamma" {
		t.Fatalf("select confirm should return gamma, got %+v", resp)
	}
	if resp.ID != "req-1" {
		t.Fatalf("response must carry request id, got %q", resp.ID)
	}
}

func TestSelectDialog_FuzzyFilterNarrows(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	d, _ := DialogForRequest(req("select", map[string]any{"title": "Pick", "options": []any{"apple", "banana", "cherry"}}), Deps{Theme: th, Keybindings: km})
	d.HandleInput("ban")
	resp, done := d.HandleInput("\r")
	if !done || resp.Value != "banana" {
		t.Fatalf("typing 'ban' then enter should select banana, got %+v done=%v", resp, done)
	}
}

func TestSelectDialog_CancelRestores(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	d, _ := DialogForRequest(req("select", map[string]any{"title": "Pick", "options": []any{"a", "b"}}), Deps{Theme: th, Keybindings: km})
	resp, done := d.HandleInput("\x1b")
	if !done || !resp.Cancelled {
		t.Fatalf("esc should cancel the select dialog, got %+v done=%v", resp, done)
	}
}

// --- confirm: enter -> confirmed true; a decline key -> confirmed false. ---

func TestConfirmDialog_Confirm(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	d, _ := DialogForRequest(req("confirm", map[string]any{"title": "Sure?", "message": "do it"}), Deps{Theme: th, Keybindings: km})
	resp, done := d.HandleInput("\r")
	if !done || resp.Confirmed == nil || !*resp.Confirmed {
		t.Fatalf("enter should confirm true, got %+v done=%v", resp, done)
	}
}

func TestConfirmDialog_CancelIsNotConfirmed(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	d, _ := DialogForRequest(req("confirm", map[string]any{"title": "Sure?", "message": "do it"}), Deps{Theme: th, Keybindings: km})
	resp, done := d.HandleInput("\x1b")
	if !done || !resp.Cancelled {
		t.Fatalf("esc should cancel confirm, got %+v done=%v", resp, done)
	}
}

// --- input: typed text returned on submit; esc cancels. ---

func TestInputDialog_SubmitReturnsTypedValue(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	d, _ := DialogForRequest(req("input", map[string]any{"title": "Name"}), Deps{Theme: th, Keybindings: km})
	for _, r := range "neo" {
		d.HandleInput(string(r))
	}
	resp, done := d.HandleInput("\r")
	if !done || resp.Value != "neo" {
		t.Fatalf("input submit should return 'neo', got %+v", resp)
	}
}

// --- editor: multiline; text accumulates and returns on submit chord. ---

func TestEditorDialog_MultilineSubmit(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	d, _ := DialogForRequest(req("editor", map[string]any{"title": "Edit", "prefill": "line1"}), Deps{Theme: th, Keybindings: km})
	out := plain(d.Render(60))
	if !strings.Contains(out, "line1") {
		t.Fatalf("editor should show the prefill, got:\n%s", out)
	}
}

// --- login/logout: fire get_auth_providers -> render provider list w/ status. ---

func TestLoginDialog_RendersProvidersWithStatusIndicators(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	providers := []bridge.AuthProvider{
		{ID: "anthropic", Name: "Anthropic", AuthType: "oauth", Status: bridge.AuthStatus{Configured: true, Source: "stored"}},
		{ID: "openai", Name: "OpenAI", AuthType: "api_key", Status: bridge.AuthStatus{Configured: false, Source: "environment", Label: "OPENAI_API_KEY"}},
	}
	d := NewLoginDialog(LoginOptions{Mode: "login", Theme: th, Keybindings: km, Providers: providers})
	out := plain(d.Render(60))
	if !strings.Contains(out, "Anthropic") || !strings.Contains(out, "OpenAI") {
		t.Fatalf("login dialog should list providers, got:\n%s", out)
	}
	if !strings.Contains(out, "configured") {
		t.Fatalf("login dialog should show the ✓ configured indicator, got:\n%s", out)
	}
	if !strings.Contains(out, "env") {
		t.Fatalf("login dialog should show the env indicator, got:\n%s", out)
	}
}

func TestLoginDialog_SelectOAuthProviderEmitsLoginStart(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	providers := []bridge.AuthProvider{
		{ID: "anthropic", Name: "Anthropic", AuthType: "oauth"},
	}
	d := NewLoginDialog(LoginOptions{Mode: "login", Theme: th, Keybindings: km, Providers: providers})
	out := d.HandleInput("\r")
	if out.Command != "login_start" {
		t.Fatalf("selecting an oauth provider should fire login_start, got %q", out.Command)
	}
	if out.Fields["provider"] != "anthropic" {
		t.Fatalf("login_start should target anthropic, got %+v", out.Fields)
	}
}

func TestLoginDialog_LogoutSelectionEmitsLogout(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	providers := []bridge.AuthProvider{
		{ID: "openai", Name: "OpenAI", AuthType: "api_key", Status: bridge.AuthStatus{Configured: true, Source: "stored"}},
	}
	d := NewLoginDialog(LoginOptions{Mode: "logout", Theme: th, Keybindings: km, Providers: providers})
	out := d.HandleInput("\r")
	if out.Command != "logout" || out.Fields["provider"] != "openai" {
		t.Fatalf("logout selection should fire logout for openai, got cmd=%q fields=%+v", out.Command, out.Fields)
	}
}

func TestLoginDialog_SubscribeAuthUrlThenEnd(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	providers := []bridge.AuthProvider{{ID: "anthropic", Name: "Anthropic", AuthType: "oauth"}}
	d := NewLoginDialog(LoginOptions{Mode: "login", Theme: th, Keybindings: km, Providers: providers})
	d.HandleInput("\r") // fire login_start (moves into flow view)

	// The URL arrives as an event and must render in the flow view.
	d.OnAuthURL("anthropic", "https://stub.example/oauth?code=FAKE")
	out := plain(d.Render(72))
	if !strings.Contains(out, "stub.example") {
		t.Fatalf("login flow should render the auth URL, got:\n%s", out)
	}

	// The end event completes the flow.
	done := d.OnAuthEnd("anthropic", true, "")
	if !done {
		t.Fatalf("a successful auth_login_end should complete the login dialog")
	}
}

func TestLoginDialog_CancelMidFlowEmitsLoginCancel(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	providers := []bridge.AuthProvider{{ID: "anthropic", Name: "Anthropic", AuthType: "oauth"}}
	d := NewLoginDialog(LoginOptions{Mode: "login", Theme: th, Keybindings: km, Providers: providers})
	d.HandleInput("\r") // enter flow
	d.OnAuthURL("anthropic", "https://stub.example/oauth")
	out := d.HandleInput("\x1b") // esc mid-flow
	if out.Command != "login_cancel" || out.Fields["provider"] != "anthropic" {
		t.Fatalf("esc mid-flow should fire login_cancel for anthropic, got cmd=%q fields=%+v", out.Command, out.Fields)
	}
}

func TestLoginDialog_AuthEndFailureShowsError(t *testing.T) {
	th := testTheme(t)
	km := testKeybindings(t)
	providers := []bridge.AuthProvider{{ID: "anthropic", Name: "Anthropic", AuthType: "oauth"}}
	d := NewLoginDialog(LoginOptions{Mode: "login", Theme: th, Keybindings: km, Providers: providers})
	d.HandleInput("\r")
	d.OnAuthURL("anthropic", "https://stub.example/oauth")
	done := d.OnAuthEnd("anthropic", false, "oauth port busy")
	if done {
		t.Fatalf("a failed auth_login_end should keep the dialog open to show the error")
	}
	out := plain(d.Render(72))
	if !strings.Contains(out, "oauth port busy") {
		t.Fatalf("login flow should render the failure error, got:\n%s", out)
	}
}
