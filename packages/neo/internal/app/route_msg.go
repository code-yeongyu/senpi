package app

import (
	"encoding/json"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript"
)

// route_msg.go holds the per-message handlers the Update loop dispatches to:
// command-result fan-out, bootstrap seeding, recovery adoption, and the
// slash/overlay/native intent execution.

// handleCommandResult fans a command round-trip onto the bash block, the footer
// stats, a pending composite post-step, and a pending overlay open; a genuine
// command failure (not an advisory stats refresh) surfaces as a notice.
func (m *Model) handleCommandResult(msg CommandResultMsg) tea.Cmd {
	if m.router != nil && m.router.HandleBashResult(msg) {
		return nil
	}
	m.refreshOverlayCtxFromResult(msg)
	statsConsumed := m.wire != nil && m.wire.HandleCommandResult(msg)

	var cmds []tea.Cmd
	if m.pendingFollow != slash.NativeNone {
		cmds = append(cmds, m.runFollow(m.pendingFollow, msg))
		m.pendingFollow = slash.NativeNone
	}
	if m.pendingOverlay != OverlayNone {
		if ov, ok := m.buildFetchedOverlay(msg.Command, msg.Response); ok {
			m.overlayMgr().Push(m.pendingOverlay, ov, m.editorText())
			m.pendingOverlay = OverlayNone
		}
	}
	if statsConsumed {
		return joinCmds(cmds...)
	}
	switch {
	case msg.Err != nil:
		cmds = append(cmds, m.noticeCmd(msg.Command+": "+msg.Err.Error()))
	case !msg.Response.Success && msg.Response.Error != "":
		cmds = append(cmds, m.noticeCmd(msg.Command+": "+msg.Response.Error))
	}
	return joinCmds(cmds...)
}

// handleBootstrap seeds the footer/title, wires autocomplete from the dynamic
// command set, refreshes the overlay build context, and delivers the launch
// inputs exactly once.
func (m *Model) handleBootstrap(msg BootstrapMsg) tea.Cmd {
	if m.wire != nil {
		m.wire.HandleBootstrap(msg)
	}
	m.noteSessionID(msg)
	m.refreshOverlayCtx(msg)
	if m.router != nil && msg.Commands.Success {
		m.router.WireAutocomplete(decodeCommands(msg.Commands.Data), m.requester.cwd, "")
	}

	var cmds []tea.Cmd
	if msg.Err != nil {
		cmds = append(cmds, m.noticeCmd("bootstrap: "+msg.Err.Error()))
	}
	if !m.initialInputsSent {
		m.initialInputsSent = true
		if _, s := m.ref.get(); s != nil {
			cmds = append(cmds, s.InitialInputs())
		}
	}
	return joinCmds(cmds...)
}

// decodeCommands accepts either {commands:[...]} or a bare [...] get_commands
// payload (defensive against either wire shape).
func decodeCommands(data json.RawMessage) []bridge.RPCSlashCommand {
	var wrapped struct {
		Commands []bridge.RPCSlashCommand `json:"commands"`
	}
	if json.Unmarshal(data, &wrapped) == nil && len(wrapped.Commands) > 0 {
		return wrapped.Commands
	}
	var bare []bridge.RPCSlashCommand
	_ = json.Unmarshal(data, &bare)
	return bare
}

// refreshOverlayCtxFromResult keeps the overlay build context current across the
// round-trips that change what "current" means: no RPC event carries model
// switches, so a reopened /model selector would ✓-mark the OLD model from the
// bootstrap-era snapshot (the backend had switched; only this view was stale).
func (m *Model) refreshOverlayCtxFromResult(msg CommandResultMsg) {
	if msg.Err != nil || !msg.Response.Success {
		return
	}
	if msg.Command != "set_model" && msg.Command != "cycle_model" {
		return
	}
	var mm struct {
		ID       string `json:"id"`
		Provider string `json:"provider"`
	}
	if len(msg.Response.Data) == 0 || json.Unmarshal(msg.Response.Data, &mm) != nil || mm.ID == "" || mm.Provider == "" {
		return // null cycle result (nowhere to go) keeps the current snapshot
	}
	m.overlayCtx.currentModel = mm.Provider + "/" + mm.ID
}

// noteSessionID feeds the bootstrap get_state session id to the recovery loop so
// a daemon respawn resumes the SAME session. session_info_changed keeps it fresh
// (route.go), and get_state is the authoritative source at connect/resume time.
func (m *Model) noteSessionID(msg BootstrapMsg) {
	if m.recovery == nil || !msg.State.Success {
		return
	}
	var st bridge.RPCSessionState
	if json.Unmarshal(msg.State.Data, &st) == nil && st.SessionID != "" {
		m.recovery.NoteSessionID(st.SessionID)
	}
}

// refreshOverlayCtx folds the get_state snapshot into the overlay build context.
func (m *Model) refreshOverlayCtx(msg BootstrapMsg) {
	if !msg.State.Success {
		return
	}
	var st bridge.RPCSessionState
	if json.Unmarshal(msg.State.Data, &st) != nil {
		return
	}
	m.overlayCtx.thinkingLevel = string(st.ThinkingLevel)
	m.overlayCtx.autoCompact = st.AutoCompactionEnabled
	if len(st.Model) > 0 {
		var mm struct {
			ID       string `json:"id"`
			Provider string `json:"provider"`
		}
		if json.Unmarshal(st.Model, &mm) == nil && mm.Provider != "" {
			m.overlayCtx.currentModel = mm.Provider + "/" + mm.ID
		}
	}
}

// handleSessionsScanned pushes the /resume picker from a native session scan.
func (m *Model) handleSessionsScanned(msg SessionsScannedMsg) tea.Cmd {
	if m.pendingOverlay != OverlaySession {
		return nil
	}
	m.pendingOverlay = OverlayNone
	if msg.Err != nil {
		return m.noticeCmd("sessions: " + msg.Err.Error())
	}
	m.overlayMgr().Push(OverlaySession, m.buildSessionPicker(msg.Sessions), m.editorText())
	return nil
}

// applyReplay folds recovery-resumed entries into the transcript best-effort.
func (m *Model) applyReplay(entries []ResumedEntry) {
	if m.feed == nil {
		return
	}
	for _, e := range entries {
		evs, err := transcript.ParseFeedEvents(e.Raw)
		if err != nil {
			continue
		}
		for _, fe := range evs {
			m.feed.Apply(fe)
		}
	}
}

// handleRecoveryResumed adopts the fresh client after a daemon reconnect: it
// rewires the session over the new client (so every ref-backed seam picks it up)
// and re-bootstraps to refresh state + commands. The launch inputs are NOT
// re-sent (initialInputsSent is already latched).
func (m *Model) handleRecoveryResumed(msg RecoveryResumedMsg) tea.Cmd {
	if msg.Client == nil || m.ref == nil {
		return nil
	}
	_, oldSession := m.ref.get()
	newSession := NewSession(msg.Client, m.program, m.opts)
	m.ref.set(msg.Client, newSession)
	if oldSession != nil {
		_ = oldSession.Close()
	}
	return newSession.Bootstrap()
}

// handleRecoveryFatal records the exit code and quits (the launcher re-raises it).
func (m *Model) handleRecoveryFatal(msg RecoveryFatalMsg) tea.Cmd {
	m.exitCode = msg.ExitCode
	noticeToFeed(m.feed, msg.Notice)
	return tea.Quit
}

// openOverlayFromSlash executes a slash builtin's overlay intent.
func (m *Model) openOverlayFromSlash(k slash.OverlayKind, _ string) tea.Cmd {
	appKind, special := slashOverlayToApp(k)
	switch special {
	case specialLogin:
		if m.extui != nil {
			return m.extui.OpenLogin(m.editorText())
		}
		return nil
	case specialLogout:
		if m.extui != nil {
			return m.extui.OpenLogout(m.editorText())
		}
		return nil
	case specialUnsupported:
		return m.noticeCmd("this command is not available in the Go TUI yet")
	}
	return m.openAppOverlay(appKind, m.editorText())
}

// runNative executes a slash builtin's native action.
func (m *Model) runNative(n slash.NativeKind, _ string) tea.Cmd {
	switch n {
	case slash.NativeQuit:
		return tea.Quit
	case slash.NativeReload:
		if _, s := m.ref.get(); s != nil {
			return joinCmds(m.noticeCmd("reloading…"), s.Bootstrap())
		}
		return nil
	case slash.NativeChangelog:
		return m.noticeCmd("changelog view is not available in the Go TUI yet")
	case slash.NativeExportJsonl:
		return m.noticeCmd("jsonl export is not available in the Go TUI yet")
	default:
		return m.noticeCmd("this action is not available in the Go TUI yet")
	}
}

// runFollow runs a composite RPC's post-step once its response lands.
func (m *Model) runFollow(n slash.NativeKind, _ CommandResultMsg) tea.Cmd {
	switch n {
	case slash.NativeCopyClipboard:
		return m.noticeCmd("clipboard copy is not available in the Go TUI yet")
	case slash.NativeShareGist:
		return m.noticeCmd("gist share is not available in the Go TUI yet")
	case slash.NativeImportConfirm:
		return m.noticeCmd("session import is not available in the Go TUI yet")
	}
	return nil
}
