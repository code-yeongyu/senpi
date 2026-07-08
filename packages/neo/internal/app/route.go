package app

import (
	"encoding/json"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// route.go is the interactive Update loop: it demuxes every bridge message onto
// the wave-3 collaborators (transcript translator, shell wire, input router,
// overlay/extension-UI controller, recovery loop) and routes key input through
// the overlay stack → app chords → editor, closing the seams those workers left.
// Every collaborator is nil in the presentational welcome scene, so each route is
// nil-safe.

// Update implements tea.Model.
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = v.Width, v.Height
		m.editor.SetViewport(v.Width, v.Height)
		return m, nil
	case tea.KeyboardEnhancementsMsg:
		if v.SupportsKeyDisambiguation() {
			keybindings.SetKittyProtocolActive(true)
		}
		return m, nil
	case tea.KeyPressMsg:
		return m.handleKey(v)
	case tea.PasteMsg:
		m.editor.Update(msg)
		return m, m.drainSubmits()

	case EventMsg:
		return m, m.handleEvent(v)
	case NoticeMsg:
		noticeToFeed(m.feed, v.Text)
		return m, nil
	case CommandResultMsg:
		return m, m.handleCommandResult(v)
	case BootstrapMsg:
		return m, m.handleBootstrap(v)
	case FileOpResultMsg:
		if v.Notice != "" {
			noticeToFeed(m.feed, v.Notice)
		}
		return m, nil
	case SessionsScannedMsg:
		return m, m.handleSessionsScanned(v)
	case replayEntriesMsg:
		m.applyReplay(v.entries)
		return m, nil

	case ExtensionUIRequestMsg:
		if m.extui != nil {
			return m, m.extui.HandleRequest(v.Request, m.editorText())
		}
		return m, nil
	case ExtUIDialogTimeoutMsg:
		if m.extui != nil {
			res := m.extui.HandleTimeout(v)
			m.applyRestore(res)
			return m, res.Cmd
		}
		return m, nil
	case LoginProvidersMsg:
		if m.extui != nil {
			return m, m.extui.HandleLoginProviders(v)
		}
		return m, nil
	case ExtUIRespondedMsg, ExtensionErrorMsg:
		return m, nil

	case ClientClosedMsg:
		if m.recovery != nil {
			return m, m.recovery.HandleClientClosed(v)
		}
		return m, nil
	case RecoveryResumedMsg:
		return m, m.handleRecoveryResumed(v)
	case RecoveryFatalMsg:
		return m, m.handleRecoveryFatal(v)

	case AbortRequested:
		return m, call(m.ref, func(s *Session) tea.Cmd { return s.Abort() })
	}
	return m, nil
}

// handleKey routes a key press: an active overlay (or the overlay-launching
// chords) claims it first, then the app-level action chords resolve through the
// Manager, then transcript presentation toggles, and finally the focused editor.
func (m *Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	raw := editor.KeyToRaw(tea.Key(msg))

	if m.overlays != nil {
		if res := m.overlays.HandleKey(raw); res.Handled {
			m.applyRestore(res)
			if res.OpenKind != OverlayNone {
				m.pendingOverlay = res.OpenKind
			}
			return m, res.Cmd
		}
	}

	// Router-owned action chords (follow-up queue, dequeue, bash interrupt).
	if m.router != nil {
		for _, action := range []string{actionFollowUp, actionDequeue, actionInterrupt} {
			if !m.keys.Matches(raw, action) {
				continue
			}
			if res, ok := m.router.HandleAction(action); ok {
				return m, m.interpretRoute(res)
			}
			if action == actionInterrupt {
				return m, emitAbort // no bash running → abort the agent turn
			}
		}
	}

	if m.keys.Matches(raw, actionInterrupt) && m.router == nil {
		return m, emitAbort
	}
	if m.keys.Matches(raw, actionExit) && m.editor.GetText() == "" {
		return m, tea.Quit
	}

	// Transcript presentation toggles (tools expand / thinking hide).
	if m.xscript != nil && m.xscript.HandleKey(raw) {
		return m, nil
	}

	m.editor.Update(msg)
	return m, m.drainSubmits()
}

// drainSubmits classifies every editor submission captured during key handling
// (editor.OnSubmit appends to m.submits) and batches the resulting commands.
func (m *Model) drainSubmits() tea.Cmd {
	if len(m.submits) == 0 || m.router == nil {
		m.submits = nil
		return nil
	}
	texts := m.submits
	m.submits = nil
	var cmds []tea.Cmd
	for _, text := range texts {
		cmds = append(cmds, m.interpretRoute(m.router.Submit(text)))
	}
	return joinCmds(cmds...)
}

// interpretRoute maps a Router RouteResult onto the wiring's side effects.
func (m *Model) interpretRoute(res RouteResult) tea.Cmd {
	switch res.Kind {
	case RouteNone:
		return nil
	case RoutePrompt, RouteSteerQueued, RouteBash:
		return res.Cmd
	case RouteRPC:
		m.pendingFollow = res.Follow // composite post-step run on the RPC response
		return res.Cmd
	case RouteOverlay:
		return m.openOverlayFromSlash(res.Overlay, res.Arg)
	case RouteNative:
		return m.runNative(res.Native, res.Arg)
	default: // RouteFollowUpQueued/RouteDequeued/RouteAbortBash/RouteBashBusy/RouteUnknown
		// RouteAbortBash carries the abort_bash command; the notice-only arms
		// carry a nil Cmd, so joining is safe for all of them.
		return joinCmds(res.Cmd, m.noticeCmd(res.Notice))
	}
}

// handleEvent fans one session event onto the transcript, shell wire, recovery
// bookkeeping, input router, and (for auth events) the extension-UI controller.
func (m *Model) handleEvent(msg EventMsg) tea.Cmd {
	ev := msg.Event

	if m.recovery != nil {
		if id := entryID(ev); id != "" {
			m.recovery.NoteEntryID(id)
		}
		switch ev.Type {
		case "agent_start":
			m.recovery.MarkTurnInFlight()
		case "agent_end":
			m.recovery.MarkTurnComplete()
		}
	}

	// Auth login events belong to the login dialog; when it claims one, don't also
	// route it to the transcript/shell surfaces.
	if m.extui != nil {
		if res := m.extui.HandleEvent(ev); res.Handled {
			m.applyRestore(res)
			return res.Cmd
		}
	}

	var cmds []tea.Cmd
	if m.xscript != nil {
		m.xscript.HandleEvent(msg)
	}
	if m.wire != nil {
		cmds = append(cmds, m.wire.HandleEvent(msg))
	}
	if m.router != nil {
		switch ev.Type {
		case "agent_start":
			m.router.SetStreaming(true)
		case "agent_end":
			cmds = append(cmds, m.router.AgentEnd())
		case "queue_update":
			m.router.SyncSteering(steeringFrom(ev))
		}
	}
	return joinCmds(cmds...)
}

// applyRestore restores the saved editor text when an overlay/extui result asks
// for it (esc/cancel of a modal).
func (m *Model) applyRestore(res OverlayKeyResult) {
	if res.Restore && m.editor != nil {
		m.editor.SetText(res.RestoreText)
	}
}

// editorText reads the live editor draft (empty in the presentational scene).
func (m *Model) editorText() string {
	if m.editor == nil {
		return ""
	}
	return m.editor.GetText()
}

// noticeCmd emits a one-line transcript notice (nil for empty text).
func (m *Model) noticeCmd(text string) tea.Cmd {
	if text == "" {
		return nil
	}
	return func() tea.Msg { return NoticeMsg{Text: text} }
}

// emitAbort publishes an AbortRequested message (consumed as session.Abort).
func emitAbort() tea.Msg { return AbortRequested{} }

// entryID best-effort extracts a persisted entry id from an event payload so the
// next recovery resume can pass it as get_entries{since}.
func entryID(ev bridge.Event) string {
	if len(ev.Payload) == 0 {
		return ""
	}
	var p struct {
		EntryID string `json:"entryId"`
		ID      string `json:"id"`
		Entry   struct {
			ID string `json:"id"`
		} `json:"entry"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil {
		return ""
	}
	switch {
	case p.EntryID != "":
		return p.EntryID
	case p.Entry.ID != "":
		return p.Entry.ID
	case ev.Type == "entry_appended" && p.ID != "":
		return p.ID
	}
	return ""
}

// steeringFrom decodes the steering list from a queue_update payload.
func steeringFrom(ev bridge.Event) []string {
	var p struct {
		Steering []string `json:"steering"`
	}
	_ = json.Unmarshal(ev.Payload, &p)
	return p.Steering
}
