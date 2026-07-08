package app

import (
	"encoding/json"
	"errors"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/builtinext"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/extui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// extui.go wires the extension-UI bridge into the app layer (plan todo 6). An
// ExtensionUIRequestMsg routes through extui.DialogForRequest / ApplyRequest:
// the interactive dialogs (select/confirm/input/editor) are pushed onto the
// todo-5 overlay Manager as app.Overlay entries, the fire-and-forget directives
// (notify/setStatus/setWidget/setTitle/set_editor_text) land on the narrow
// DirectiveSink (their shell/editor application is todo-9 wiring), and the
// additive custom_unsupported method renders the builtinext notice. A finished
// dialog answers with an extension_ui_response carrying the ORIGINAL request id
// — never a req_N command id — so the ExtensionUIResponder seam writes the line
// directly instead of going through Client.Request. Timeout semantics mirror
// connection-handler.ts: a timeout-bearing request arms a timer whose expiry
// sends the default cancel response and dismisses the dialog.
//
// It also owns the /login /logout flows: get_auth_providers → extui.NewLoginDialog
// → login_start issued with NO timeout (the event-completed exemption,
// bridge/client.go) → the auth_login_url event renders the URL panel → a
// successful auth_login_end closes the dialog with a status notice, a failed one
// keeps it open showing the error; esc mid-flow fires login_cancel.
//
// ExtUI implements the Model's OverlayStack by decorating the Manager: the
// wiring (todo 9) must install the ExtUI — not the bare Manager — as the
// Model's overlay stack so completed dialogs can attach their response send to
// the key's tea.Cmd. Every command leaves as a tea.Cmd; nothing blocks the
// Update goroutine.

// Overlay kinds owned by the extension-UI layer, allocated after the manager's
// twelve built-in kinds (OverlayModel..OverlayObserver) so they never collide.
const (
	// OverlayExtUI hosts an extension dialog (select/confirm/input/editor) or
	// the custom_unsupported notice.
	OverlayExtUI OverlayKind = OverlayObserver + 1 + iota
	// OverlayLogin hosts the /login /logout dialog and its api-key prompt.
	OverlayLogin
)

// extUIExpireSignal is the non-key control string cycled through the Manager to
// pop an overlay the controller finished from the outside (dialog timeout,
// successful auth_login_end). It is never matched against a binding: the
// flagged adapter returns on its own done/close flag before any key
// resolution, and every live dialog treats the unmatched NUL-prefixed string as
// a no-op (not printable, no chord).
const extUIExpireSignal = "\x00extui.expire"

// ExtUIRequestDoer issues one RPC command with a per-call timeout. It is the
// narrow slice of *bridge.Client the extension-UI layer needs; a zero timeout
// waits indefinitely (reserved for login_start, the event-completed exemption).
type ExtUIRequestDoer interface {
	Request(cmd bridge.Command, timeout time.Duration) (bridge.Response, error)
}

var _ ExtUIRequestDoer = (*bridge.Client)(nil)

// ExtensionUIResponder writes one extension_ui_response line to the bridge
// stdin, preserving the originating request id. The todo-9 wiring implements it
// over the transport's line writer; tests inject a recorder.
type ExtensionUIResponder interface {
	RespondExtensionUI(resp bridge.ExtensionUIResponse) error
}

// DirectiveSink receives the fire-and-forget extension directives. The shell
// (setStatus/setWidget/notify → todo 7 regions), terminal title, and editor
// (set_editor_text) application is todo-9 wiring; tests inject a recorder.
type DirectiveSink interface {
	ApplyDirective(d extui.Directive)
}

// ExtUIDialogTimeoutMsg fires when a timeout-bearing dialog request's deadline
// elapsed. Route it to ExtUI.HandleTimeout.
type ExtUIDialogTimeoutMsg struct{ ID string }

// ExtUIRespondedMsg reports the outcome of an extension_ui_response write. It
// is advisory: the TS host resolves its default on its own timer regardless.
type ExtUIRespondedMsg struct {
	Err error
	ID  string
}

// LoginProvidersMsg carries the get_auth_providers result back to the update
// loop, where HandleLoginProviders builds and pushes the login dialog.
type LoginProvidersMsg struct {
	Err       error
	Mode      string
	SavedText string
	Providers []bridge.AuthProvider
}

// ExtUI is the extension-UI + login controller. It decorates the todo-5 overlay
// Manager as the Model's OverlayStack, tracking the live extension dialogs (by
// request id) and the login flow so out-of-band completions (timeouts, auth
// events) can close them and attach their sends as tea.Cmds.
type ExtUI struct {
	deps      extui.Deps
	mgr       *Manager
	client    ExtUIRequestDoer
	responder ExtensionUIResponder
	sink      DirectiveSink
	dialogs   map[string]*extDialogOverlay
	login     *loginOverlay
	pending   []tea.Cmd
}

// NewExtUI builds the controller over the overlay manager and the three seams.
func NewExtUI(deps extui.Deps, mgr *Manager, client ExtUIRequestDoer, responder ExtensionUIResponder, sink DirectiveSink) *ExtUI {
	return &ExtUI{
		deps:      deps,
		mgr:       mgr,
		client:    client,
		responder: responder,
		sink:      sink,
		dialogs:   map[string]*extDialogOverlay{},
	}
}

var _ OverlayStack = (*ExtUI)(nil)

// Active reports whether a modal overlay is open (delegates to the Manager).
func (c *ExtUI) Active() bool { return c.mgr.Active() }

// Render draws the active overlay frame (delegates to the Manager).
func (c *ExtUI) Render(width, height int) []string { return c.mgr.Render(width, height) }

// HandleKey routes a raw key through the Manager and attaches any sends the
// adapters queued while handling it (extension_ui_response writes, auth
// commands) to the result's tea.Cmd.
func (c *ExtUI) HandleKey(raw string) OverlayKeyResult {
	res := c.mgr.HandleKey(raw)
	res.Cmd = joinCmds(res.Cmd, c.drain())
	return res
}

// HandleRequest routes one extension_ui_request. Interactive methods open a
// dialog overlay (savedEditorText is the editor text live at open, restored on
// close — master task-12 semantics) and return the timeout timer command when
// the request carries one; directives apply to the sink; custom_unsupported
// opens the builtinext notice. Fire-and-forget methods send no response line.
func (c *ExtUI) HandleRequest(req bridge.ExtensionUIRequest, savedEditorText string) tea.Cmd {
	if req.Method == builtinext.CustomUnsupportedMethod {
		ov := &extNoticeOverlay{}
		notice, ok := builtinext.NoticeForRequest(req, builtinext.NoticeDeps{
			Theme:       c.deps.Theme,
			Keybindings: c.deps.Keybindings,
			Done:        func() { ov.done = true },
		})
		if !ok {
			return nil
		}
		ov.notice = notice
		c.mgr.Push(OverlayExtUI, ov, savedEditorText)
		return nil
	}
	if dir, ok := extui.ApplyRequest(req); ok {
		c.sink.ApplyDirective(dir)
		return nil
	}
	dialog, ok := extui.DialogForRequest(req, c.deps)
	if !ok {
		return nil // not a mirrored method; the bridge exhaustiveness gate keeps this dead
	}
	ov := &extDialogOverlay{ctrl: c, dialog: dialog}
	c.dialogs[req.ID] = ov
	c.mgr.Push(OverlayExtUI, ov, savedEditorText)
	return dialogTimeoutCmd(req)
}

// dialogTimeoutCmd arms the per-request timer when the request carries a
// timeout (milliseconds, mirroring connection-handler.ts setTimeout).
func dialogTimeoutCmd(req bridge.ExtensionUIRequest) tea.Cmd {
	ms, ok := req.Fields["timeout"].(float64)
	if !ok || ms <= 0 {
		return nil
	}
	id := req.ID
	d := time.Duration(ms) * time.Millisecond
	return func() tea.Msg {
		time.Sleep(d)
		return ExtUIDialogTimeoutMsg{ID: id}
	}
}

// HandleTimeout resolves an elapsed dialog deadline: the default cancel
// response is sent with the original request id and the dialog is popped when
// it is the active overlay (restoring the saved editor text). A stale timeout
// for an already-answered dialog is a no-op.
func (c *ExtUI) HandleTimeout(msg ExtUIDialogTimeoutMsg) OverlayKeyResult {
	ov, ok := c.dialogs[msg.ID]
	if !ok || ov.done {
		return OverlayKeyResult{}
	}
	ov.done = true
	delete(c.dialogs, msg.ID)
	c.queue(c.respondCmd(extui.Response{ID: msg.ID, Cancelled: true}))
	return c.popFlagged(OverlayExtUI)
}

// HandleEvent routes the auth login events to the live login dialog. Handled is
// false for every other event (or when no login flow is open) so the caller
// keeps routing it to the transcript/shell layers.
func (c *ExtUI) HandleEvent(ev bridge.Event) OverlayKeyResult {
	if c.login == nil {
		return OverlayKeyResult{}
	}
	switch ev.Type {
	case "auth_login_url":
		var p struct {
			Provider string `json:"provider"`
			URL      string `json:"url"`
		}
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return OverlayKeyResult{}
		}
		c.login.dialog.OnAuthURL(p.Provider, p.URL)
		return OverlayKeyResult{Handled: true}
	case "auth_login_end":
		var p struct {
			Provider string `json:"provider"`
			Error    string `json:"error"`
			Success  bool   `json:"success"`
		}
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return OverlayKeyResult{}
		}
		if !c.login.dialog.OnAuthEnd(p.Provider, p.Success, p.Error) {
			return OverlayKeyResult{Handled: true} // failure: stays open showing the error
		}
		c.login.closeRequested = true
		res := c.popFlagged(OverlayLogin)
		res.Cmd = joinCmds(res.Cmd, notice("Logged in to "+p.Provider))
		return res
	}
	return OverlayKeyResult{}
}

// popFlagged cycles the expire signal through the Manager when the given kind
// is on top, so the flagged adapter pops itself (restoring the saved editor
// text), then attaches the queued sends. When another overlay is stacked on top
// the flagged one closes on its next key instead.
func (c *ExtUI) popFlagged(kind OverlayKind) OverlayKeyResult {
	res := OverlayKeyResult{Handled: true}
	if c.mgr.ActiveKind() == kind {
		res = c.mgr.HandleKey(extUIExpireSignal)
		res.Handled = true
	}
	res.Cmd = joinCmds(res.Cmd, c.drain())
	return res
}

// OpenLogin fetches the provider list for the /login selector. savedEditorText
// travels through the fetch so the dialog push can save/restore it.
func (c *ExtUI) OpenLogin(savedEditorText string) tea.Cmd {
	return c.fetchProviders("login", savedEditorText)
}

// OpenLogout fetches the provider list for the /logout selector.
func (c *ExtUI) OpenLogout(savedEditorText string) tea.Cmd {
	return c.fetchProviders("logout", savedEditorText)
}

func (c *ExtUI) fetchProviders(mode, savedText string) tea.Cmd {
	client := c.client
	return func() tea.Msg {
		msg := LoginProvidersMsg{Mode: mode, SavedText: savedText}
		resp, err := client.Request(bridge.Command{Type: "get_auth_providers"}, bridge.DefaultRequestTimeout)
		if err != nil {
			msg.Err = err
			return msg
		}
		if !resp.Success {
			msg.Err = errors.New(resp.Error)
			return msg
		}
		var data struct {
			Providers []bridge.AuthProvider `json:"providers"`
		}
		if err := json.Unmarshal(resp.Data, &data); err != nil {
			msg.Err = err
			return msg
		}
		msg.Providers = data.Providers
		return msg
	}
}

// HandleLoginProviders builds and pushes the login dialog once the provider
// fetch resolves (on the Update goroutine — the Manager is not safe off it). A
// fetch error surfaces as a one-line notice instead.
func (c *ExtUI) HandleLoginProviders(msg LoginProvidersMsg) tea.Cmd {
	if msg.Err != nil {
		return notice("login: " + msg.Err.Error())
	}
	dialog := extui.NewLoginDialog(extui.LoginOptions{
		Mode:        msg.Mode,
		Theme:       c.deps.Theme,
		Keybindings: c.deps.Keybindings,
		Providers:   msg.Providers,
	})
	ov := &loginOverlay{ctrl: c, dialog: dialog}
	c.login = ov
	c.mgr.Push(OverlayLogin, ov, msg.SavedText)
	return nil
}

// openAPIKeyPrompt pushes the key input for an api_key provider; its submit
// fires login_api_key (a login step, never an extension_ui_response).
func (c *ExtUI) openAPIKeyPrompt(provider, savedText string) {
	dialog, ok := extui.DialogForRequest(bridge.ExtensionUIRequest{
		Type:   "extension_ui_request",
		ID:     "login_api_key:" + provider,
		Method: "input",
		Fields: map[string]any{"title": "Enter API key for " + provider, "placeholder": "API key"},
	}, c.deps)
	if !ok {
		return
	}
	c.mgr.Push(OverlayLogin, &apiKeyOverlay{ctrl: c, dialog: dialog, provider: provider}, savedText)
}

// --- command plumbing ---------------------------------------------------------

// queue defers a command to the next drain, so adapters running inside
// Manager.HandleKey can attach sends to the key's result.
func (c *ExtUI) queue(cmd tea.Cmd) {
	if cmd != nil {
		c.pending = append(c.pending, cmd)
	}
}

func (c *ExtUI) drain() tea.Cmd {
	if len(c.pending) == 0 {
		return nil
	}
	cmds := c.pending
	c.pending = nil
	return joinCmds(cmds...)
}

// respondCmd builds the tea.Cmd that writes the extension_ui_response line,
// mapping the dialog outcome onto the three TS response variants (cancelled /
// confirmed / value).
func (c *ExtUI) respondCmd(resp extui.Response) tea.Cmd {
	wire := bridge.ExtensionUIResponse{Type: "extension_ui_response", ID: resp.ID}
	switch {
	case resp.Cancelled:
		wire.Cancelled = true
	case resp.Confirmed != nil:
		wire.Confirmed = resp.Confirmed
	default:
		wire.Value = resp.Value
	}
	responder := c.responder
	return func() tea.Msg {
		return ExtUIRespondedMsg{ID: wire.ID, Err: responder.RespondExtensionUI(wire)}
	}
}

// requestCmd issues an auth command off the Update goroutine at the given
// timeout (0 = wait indefinitely — reserved for login_start).
func (c *ExtUI) requestCmd(cmd bridge.Command, timeout time.Duration) tea.Cmd {
	client := c.client
	return func() tea.Msg {
		resp, err := client.Request(cmd, timeout)
		return CommandResultMsg{Command: cmd.Type, Response: resp, Err: err}
	}
}

func (c *ExtUI) clearLogin(o *loginOverlay) {
	if c.login == o {
		c.login = nil
	}
}

// joinCmds batches the non-nil commands (nil when none, unwrapped when one).
func joinCmds(cmds ...tea.Cmd) tea.Cmd {
	var live []tea.Cmd
	for _, cmd := range cmds {
		if cmd != nil {
			live = append(live, cmd)
		}
	}
	switch len(live) {
	case 0:
		return nil
	case 1:
		return live[0]
	default:
		return tea.Batch(live...)
	}
}

func stripLines(lines []string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = ui.StripANSI(l)
	}
	return out
}

// --- overlay adapters -----------------------------------------------------------

// extDialogOverlay adapts an extui.Dialog to the Manager's Overlay contract.
// The dialog resolves its keys through its own keybinding manager (injected via
// extui.Deps), so the kb parameter is unused here.
type extDialogOverlay struct {
	ctrl   *ExtUI
	dialog extui.Dialog
	done   bool
}

func (o *extDialogOverlay) HandleKey(data string, _ *keybindings.Manager, savedText string) overlays.Outcome {
	if o.done {
		// Timed out from the outside (response already sent): any key dismisses.
		return overlays.Outcome{Kind: overlays.OutcomeCancel, RestoreText: savedText}
	}
	resp, finished := o.dialog.HandleInput(data)
	if !finished {
		return overlays.Outcome{Kind: overlays.OutcomeNone}
	}
	o.done = true
	delete(o.ctrl.dialogs, o.dialog.RequestID())
	o.ctrl.queue(o.ctrl.respondCmd(resp))
	if resp.Cancelled {
		return overlays.Outcome{Kind: overlays.OutcomeCancel, RestoreText: savedText}
	}
	return overlays.Outcome{Kind: overlays.OutcomeSelect}
}

func (o *extDialogOverlay) RenderPlain(width int) []string {
	return stripLines(o.dialog.Render(width))
}
func (o *extDialogOverlay) RenderStyled(width int) []string { return o.dialog.Render(width) }

// extNoticeOverlay hosts the custom_unsupported notice. No response line is
// sent: the TS host resolves ctx.ui.custom to undefined on its own.
type extNoticeOverlay struct {
	notice *builtinext.CustomUnsupportedNotice
	done   bool
}

func (o *extNoticeOverlay) HandleKey(data string, _ *keybindings.Manager, savedText string) overlays.Outcome {
	o.notice.HandleInput(data) // flips done via the Done callback on confirm/cancel
	if o.done {
		return overlays.Outcome{Kind: overlays.OutcomeCancel, RestoreText: savedText}
	}
	return overlays.Outcome{Kind: overlays.OutcomeNone}
}

func (o *extNoticeOverlay) RenderPlain(width int) []string {
	return stripLines(o.notice.Render(width))
}
func (o *extNoticeOverlay) RenderStyled(width int) []string { return o.notice.Render(width) }

// loginOverlay adapts extui.LoginDialog: provider selection fires login_start
// (oauth, NO timeout) / logout / the api-key prompt; esc mid-flow fires
// login_cancel; a successful auth_login_end sets closeRequested so the next
// signal pops it.
type loginOverlay struct {
	ctrl           *ExtUI
	dialog         *extui.LoginDialog
	closeRequested bool
}

func (o *loginOverlay) HandleKey(data string, _ *keybindings.Manager, savedText string) overlays.Outcome {
	if o.closeRequested {
		o.ctrl.clearLogin(o)
		return overlays.Outcome{Kind: overlays.OutcomeCancel, RestoreText: savedText}
	}
	cmd := o.dialog.HandleInput(data)
	if cmd.Done {
		o.ctrl.clearLogin(o)
		return overlays.Outcome{Kind: overlays.OutcomeCancel, RestoreText: savedText}
	}
	switch cmd.Command {
	case "login_start":
		// Fire-then-subscribe: NO request timeout (the bridge event-completed
		// exemption) — completion arrives as auth_login_url / auth_login_end.
		o.ctrl.queue(o.ctrl.requestCmd(bridge.Command{Type: cmd.Command, Fields: cmd.Fields}, 0))
		return overlays.Outcome{Kind: overlays.OutcomeNone} // the flow view stays open
	case "login_cancel":
		o.ctrl.queue(o.ctrl.requestCmd(bridge.Command{Type: cmd.Command, Fields: cmd.Fields}, bridge.DefaultRequestTimeout))
		o.ctrl.clearLogin(o)
		return overlays.Outcome{Kind: overlays.OutcomeCancel, RestoreText: savedText}
	case "logout":
		o.ctrl.queue(o.ctrl.requestCmd(bridge.Command{Type: cmd.Command, Fields: cmd.Fields}, bridge.DefaultRequestTimeout))
		o.ctrl.clearLogin(o)
		return overlays.Outcome{Kind: overlays.OutcomeSelect}
	case "login_api_key_prompt":
		provider, _ := cmd.Fields["provider"].(string)
		o.ctrl.openAPIKeyPrompt(provider, savedText)
		return overlays.Outcome{Kind: overlays.OutcomeNone}
	}
	return overlays.Outcome{Kind: overlays.OutcomeNone}
}

func (o *loginOverlay) RenderPlain(width int) []string {
	return stripLines(o.dialog.Render(width))
}
func (o *loginOverlay) RenderStyled(width int) []string { return o.dialog.Render(width) }

// apiKeyOverlay maps the key input's outcome onto a login_api_key command. The
// typed key only crosses the requestCmd seam — it is never echoed to a notice
// or an extension_ui_response.
type apiKeyOverlay struct {
	ctrl     *ExtUI
	dialog   extui.Dialog
	provider string
}

func (o *apiKeyOverlay) HandleKey(data string, _ *keybindings.Manager, savedText string) overlays.Outcome {
	resp, finished := o.dialog.HandleInput(data)
	if !finished {
		return overlays.Outcome{Kind: overlays.OutcomeNone}
	}
	if resp.Cancelled || resp.Value == "" {
		return overlays.Outcome{Kind: overlays.OutcomeCancel, RestoreText: savedText}
	}
	o.ctrl.queue(o.ctrl.requestCmd(bridge.Command{
		Type:   "login_api_key",
		Fields: map[string]any{"provider": o.provider, "key": resp.Value},
	}, bridge.DefaultRequestTimeout))
	return overlays.Outcome{Kind: overlays.OutcomeSelect}
}

func (o *apiKeyOverlay) RenderPlain(width int) []string {
	return stripLines(o.dialog.Render(width))
}
func (o *apiKeyOverlay) RenderStyled(width int) []string { return o.dialog.Render(width) }
