package extui

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// LoginOptions configures a /login or /logout dialog.
type LoginOptions struct {
	// Mode is "login" or "logout".
	Mode        string
	Theme       *theme.Theme
	Keybindings *keybindings.Manager
	// Providers comes from a get_auth_providers response.
	Providers []bridge.AuthProvider
}

// LoginCommand is what the login dialog asks the app shell to send. An empty
// Command means "nothing to send" (navigation/filter only). The task-3 timeout
// exemption applies: login_start is fire-command-then-subscribe, so the shell
// must NOT arm a request timeout around it — completion arrives via
// auth_login_url / auth_login_end events fed back through OnAuthURL / OnAuthEnd.
type LoginCommand struct {
	Command string
	Fields  map[string]any
	// Done is true when the dialog has finished (cancelled the whole flow) and the
	// app shell should close it.
	Done bool
}

// loginView is the current screen of the login dialog.
type loginView int

const (
	viewProviderList loginView = iota
	viewFlow
)

// LoginDialog renders /login and /logout. In the provider-list view it shows the
// OAuthSelectorComponent-style status indicators; selecting an oauth provider
// fires login_start and switches to the flow view (fire-command-then-subscribe),
// while selecting a stored credential in logout mode fires logout. The flow view
// renders the auth URL delivered by OnAuthURL and completes on OnAuthEnd.
type LoginDialog struct {
	mode      string
	th        *theme.Theme
	kb        *keybindings.Manager
	providers []bridge.AuthProvider
	list      *ui.SelectList
	view      loginView

	// flow state
	flowProvider string
	flowURL      string
	flowError    string

	top *ui.DynamicBorder
	bot *ui.DynamicBorder
}

// NewLoginDialog builds a login/logout dialog over the given provider list.
func NewLoginDialog(opts LoginOptions) *LoginDialog {
	items := make([]ui.SelectItem, len(opts.Providers))
	for i, p := range opts.Providers {
		items[i] = ui.SelectItem{Value: p.ID, Label: p.Name}
	}
	list := ui.NewSelectList(items, 8, listTheme(opts.Theme), ui.SelectListLayout{
		MinPrimaryColumnWidth: 12,
		MaxPrimaryColumnWidth: 40,
	})
	return &LoginDialog{
		mode:      opts.Mode,
		th:        opts.Theme,
		kb:        opts.Keybindings,
		providers: opts.Providers,
		list:      list,
		view:      viewProviderList,
		top:       ui.NewDynamicBorder(opts.Theme),
		bot:       ui.NewDynamicBorder(opts.Theme),
	}
}

// HandleInput feeds one key and returns the command the app shell should send.
func (d *LoginDialog) HandleInput(data string) LoginCommand {
	if d.view == viewFlow {
		// Mid-flow: esc cancels the in-flight login.
		if d.kb.Matches(data, "tui.select.cancel") {
			return LoginCommand{Command: "login_cancel", Fields: map[string]any{"provider": d.flowProvider}}
		}
		return LoginCommand{}
	}

	switch {
	case d.kb.Matches(data, "tui.select.up"):
		d.list.MoveUp()
		return LoginCommand{}
	case d.kb.Matches(data, "tui.select.down"):
		d.list.MoveDown()
		return LoginCommand{}
	case d.kb.Matches(data, "tui.select.cancel"):
		return LoginCommand{Done: true}
	case d.kb.Matches(data, "tui.select.confirm"):
		return d.selectProvider()
	}
	return LoginCommand{}
}

func (d *LoginDialog) selectProvider() LoginCommand {
	it, ok := d.list.SelectedItem()
	if !ok {
		return LoginCommand{}
	}
	provider := d.provider(it.Value)
	if provider == nil {
		return LoginCommand{}
	}
	if d.mode == "logout" {
		return LoginCommand{Command: "logout", Fields: map[string]any{"provider": provider.ID}}
	}
	// login mode: oauth providers start a browser flow (fire-then-subscribe);
	// api_key providers collect a key via an input dialog the shell opens.
	if provider.AuthType == "oauth" {
		d.view = viewFlow
		d.flowProvider = provider.ID
		return LoginCommand{Command: "login_start", Fields: map[string]any{"provider": provider.ID}}
	}
	return LoginCommand{Command: "login_api_key_prompt", Fields: map[string]any{"provider": provider.ID}}
}

// OnAuthURL feeds an auth_login_url event into the flow view.
func (d *LoginDialog) OnAuthURL(provider, url string) {
	if provider != d.flowProvider {
		return
	}
	d.flowURL = url
}

// OnAuthEnd feeds an auth_login_end event. It returns done=true when the login
// completed successfully (the shell closes the dialog); on failure it keeps the
// dialog open and records the error for the flow view.
func (d *LoginDialog) OnAuthEnd(provider string, success bool, errMsg string) (done bool) {
	if provider != d.flowProvider {
		return false
	}
	if success {
		return true
	}
	d.flowError = errMsg
	return false
}

func (d *LoginDialog) provider(id string) *bridge.AuthProvider {
	for i := range d.providers {
		if d.providers[i].ID == id {
			return &d.providers[i]
		}
	}
	return nil
}

// Render lays out the current view.
func (d *LoginDialog) Render(width int) []string {
	if d.view == viewFlow {
		return d.renderFlow(width)
	}
	return d.renderList(width)
}

func (d *LoginDialog) renderList(width int) []string {
	s := newStyler(d.th)
	title := "Select provider to configure:"
	if d.mode == "logout" {
		title = "Select provider to logout:"
	}
	lines := d.top.Render(width)
	lines = append(lines, s.title("accent", title))
	if len(d.providers) == 0 {
		empty := "No providers available"
		if d.mode == "logout" {
			empty = "No providers logged in. Use /login first."
		}
		lines = append(lines, s.fg("muted", "  "+empty))
		lines = append(lines, d.bot.Render(width)...)
		return lines
	}
	selID := ""
	if it, ok := d.list.SelectedItem(); ok {
		selID = it.Value
	}
	for _, p := range d.providers {
		prefix := "  "
		name := s.fg("text", p.Name)
		if p.ID == selID {
			prefix = s.fg("accent", "→ ")
			name = s.fg("accent", p.Name)
		}
		lines = append(lines, prefix+name+d.statusIndicator(s, p))
	}
	lines = append(lines, s.fg("dim", " ↑/↓ select · enter confirm · esc cancel"))
	lines = append(lines, d.bot.Render(width)...)
	return lines
}

// statusIndicator mirrors OAuthSelectorComponent.formatStatusIndicator
// (oauth-selector.ts:151-175): ✓ configured / env / runtime / models.json states.
func (d *LoginDialog) statusIndicator(s styler, p bridge.AuthProvider) string {
	// A stored credential matching the provider's auth type is "configured".
	if p.Status.Configured && p.Status.Source == "stored" {
		return s.fg("success", " ✓ configured")
	}
	switch p.Status.Source {
	case "environment":
		label := p.Status.Label
		if label == "" {
			label = "API key"
		}
		return s.fg("success", " ✓ env: "+label)
	case "runtime":
		return s.fg("success", " ✓ runtime API key")
	case "fallback":
		return s.fg("success", " ✓ custom API key")
	case "models_json_key":
		return s.fg("success", " ✓ key in models.json")
	case "models_json_command":
		return s.fg("success", " ✓ command in models.json")
	default:
		return s.fg("muted", " • unconfigured")
	}
}

func (d *LoginDialog) renderFlow(width int) []string {
	s := newStyler(d.th)
	name := d.flowProvider
	if p := d.provider(d.flowProvider); p != nil {
		name = p.Name
	}
	lines := d.top.Render(width)
	lines = append(lines, s.title("accent", "Login to "+name))
	if d.flowURL != "" {
		lines = append(lines, s.fg("accent", d.flowURL))
		hint := "Ctrl+click to open"
		lines = append(lines, s.fg("dim", hint))
	} else {
		lines = append(lines, s.fg("dim", "Starting login..."))
	}
	if d.flowError != "" {
		lines = append(lines, s.fg("error", "Login failed: "+d.flowError))
	}
	lines = append(lines, s.fg("dim", " esc cancel"))
	lines = append(lines, d.bot.Render(width)...)
	return lines
}

// FlowSummary returns a one-line plain description of the current flow state,
// used by the QA harness to assert without ANSI.
func (d *LoginDialog) FlowSummary() string {
	return strings.TrimSpace(ui.StripANSI(strings.Join(d.renderFlow(80), " ")))
}
