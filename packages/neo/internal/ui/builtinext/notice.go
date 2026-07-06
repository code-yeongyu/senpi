package builtinext

import (
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// CustomUnsupportedMethod is the additive extension_ui_request method a task-13
// capability-flagged TS host emits before returning undefined from ctx.ui.custom
// for a THIRD-PARTY custom component. The default (unflagged) RPC host emits
// NOTHING (verified: rpc-mode.ts:237-241 returns undefined synchronously with no
// wire message), so this method only ever appears once the neo opt-in flag is
// set. The Go side is wired here so task 13 only has to flip the TS emission on.
const CustomUnsupportedMethod = "custom_unsupported"

// CustomUnsupportedOptions configures a CustomUnsupportedNotice dialog.
type CustomUnsupportedOptions struct {
	ExtensionName string
	Theme         *theme.Theme
	Keybindings   *keybindings.Manager
	Done          func()
	RequestRender func()
}

// CustomUnsupportedNotice renders the fallback dialog shown when a third-party
// extension calls ctx.ui.custom, which neo cannot render natively. The copy is
// fixed: "this extension UI requires the classic TUI: <name>".
type CustomUnsupportedNotice struct {
	opts    CustomUnsupportedOptions
	roles   roleStyler
	topRule *ui.DynamicBorder
	botRule *ui.DynamicBorder
}

// NewCustomUnsupportedNotice builds the notice dialog.
func NewCustomUnsupportedNotice(opts CustomUnsupportedOptions) *CustomUnsupportedNotice {
	accent := func(s string) string { return newRoleStyler(opts.Theme).fg("accent", s) }
	return &CustomUnsupportedNotice{
		opts:    opts,
		roles:   newRoleStyler(opts.Theme),
		topRule: ui.NewDynamicBorderColored(accent),
		botRule: ui.NewDynamicBorderColored(accent),
	}
}

// HandleInput dismisses the dialog on enter or esc (both routed through the
// keybinding manager — no hardcoded key checks).
func (n *CustomUnsupportedNotice) HandleInput(input string) {
	km := n.opts.Keybindings
	if km.Matches(input, "tui.select.confirm") || km.Matches(input, "tui.select.cancel") {
		if n.opts.Done != nil {
			n.opts.Done()
		}
		return
	}
	if n.opts.RequestRender != nil {
		n.opts.RequestRender()
	}
}

// Render lays out the framed notice dialog.
func (n *CustomUnsupportedNotice) Render(width int) []string {
	r := n.roles
	title := r.fg("warning", r.boldText(" Extension UI unavailable"))
	body := r.fg("muted", " this extension UI requires the classic TUI: ") + r.fg("accent", n.opts.ExtensionName)
	hint := r.fg("dim", " enter/esc dismiss")

	lines := []string{}
	lines = append(lines, n.topRule.Render(width)...)
	lines = append(lines, title)
	lines = append(lines, body)
	lines = append(lines, hint)
	lines = append(lines, n.botRule.Render(width)...)
	return lines
}

// NoticeDeps carries the dependencies NoticeForRequest injects into the dialog.
type NoticeDeps struct {
	Theme         *theme.Theme
	Keybindings   *keybindings.Manager
	Done          func()
	RequestRender func()
}

// NoticeForRequest routes an additive custom_unsupported extension_ui_request to
// a notice dialog, extracting the extension name from the request's extra fields
// (`extensionName`). Any other method returns ok=false — the additive-only
// guardrail means only custom_unsupported ever reaches this path.
func NoticeForRequest(req bridge.ExtensionUIRequest, deps NoticeDeps) (*CustomUnsupportedNotice, bool) {
	if req.Method != CustomUnsupportedMethod {
		return nil, false
	}
	name := ""
	if req.Fields != nil {
		if v, ok := req.Fields["extensionName"].(string); ok {
			name = v
		}
	}
	return NewCustomUnsupportedNotice(CustomUnsupportedOptions{
		ExtensionName: name,
		Theme:         deps.Theme,
		Keybindings:   deps.Keybindings,
		Done:          deps.Done,
		RequestRender: deps.RequestRender,
	}), true
}
