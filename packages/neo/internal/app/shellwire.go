package app

import (
	"encoding/json"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
)

// shellwire.go is the todo-7 shell-wiring layer: it feeds the presentational
// shell regions (welcome/status/footer/widgets, internal/ui/shell) from live
// session state — Bootstrap get_state, on-demand get_session_stats after
// agent_end, and the event stream. It holds NO rendering logic (the shell
// components own text + styling; classic reference footer-data-provider.ts +
// footer.ts) and NO timers: stats refreshes are event-driven + on-demand only,
// and the retry countdown re-derives from an event-seeded deadline on the app's
// existing render tick.

// StatsRequester is the narrow on-demand seam the wire pulls fresh session
// stats through: after agent_end HandleEvent returns the requester's tea.Cmd,
// whose get_session_stats CommandResultMsg is routed back into
// HandleCommandResult. Todo 9 adapts the session layer to it; tests inject a
// counting fake.
type StatsRequester interface {
	SessionStats() tea.Cmd
}

// WidgetPlacement selects which editor side an extension widget renders on,
// mirroring the rpc setWidget widgetPlacement field ("aboveEditor" default).
type WidgetPlacement int

const (
	WidgetAboveEditor WidgetPlacement = iota
	WidgetBelowEditor
)

// ExtensionShellSink is the wire's OWN narrow directives seam for the
// extension-UI shell directives (setStatus/setWidget/setTitle). The todo-6
// layer produces directives against its own sink contract; todo 9 adapts that
// producer to this interface — the two halves meet there, deliberately
// uncoupled here. Empty/nil widget lines clear a key (setWidget(key, undefined)
// parity); ClearExtensionStatus mirrors setStatus(key, undefined).
type ExtensionShellSink interface {
	SetExtensionStatus(key, text string)
	ClearExtensionStatus(key string)
	SetExtensionWidget(key string, lines []string, placement WidgetPlacement)
	SetExtensionTitle(title string)
	ClearExtensionTitle()
}

// ShellWireConfig carries the wire's collaborators and environment facts.
type ShellWireConfig struct {
	// Theme builds the status indicators (spinner colors); text styling stays
	// inside the shell components — the wire emits no escape bytes itself.
	Theme *theme.Theme
	// Keys resolves the cancel-hint display for retry/compaction statuses
	// (app.interrupt), never a raw key literal.
	Keys *keybindings.Manager
	// Stats is the on-demand get_session_stats seam; nil disables refreshes.
	Stats StatsRequester
	// AppName is the terminal-title app label (e.g. "senpi").
	AppName string
	// Cwd/Home feed the footer's ~-relativized cwd and the title basename.
	Cwd  string
	Home string
	// GitBranch is the caller-resolved branch label. Watching .git belongs to
	// the environment layer (classic: footer-data-provider.ts); the wire only
	// displays what it is handed.
	GitBranch string
}

// ShellWire populates a Shell's regions from live session state: welcome until
// the first turn, footer model/cwd/thinking/token-context stats, the
// event-driven status stack (retry countdown, compaction), extension
// status/widget segments, and the terminal title exposed as readable state.
type ShellWire struct {
	sh    *shell.Shell
	th    *theme.Theme
	keys  *keybindings.Manager
	stats StatsRequester

	appName     string
	sessionName string
	extTitle    string
	hasExtTitle bool

	footer    shell.FooterData
	extStatus map[string]string

	turnSeen      bool
	retryDeadline time.Time
}

var _ ExtensionShellSink = (*ShellWire)(nil)

// NewShellWire binds the wire to the shell it populates and seeds the static
// footer facts (cwd/home/branch) so the HUD is meaningful before bootstrap.
func NewShellWire(sh *shell.Shell, cfg ShellWireConfig) *ShellWire {
	appName := cfg.AppName
	if appName == "" {
		appName = defaultAppName
	}
	w := &ShellWire{
		sh:        sh,
		th:        cfg.Theme,
		keys:      cfg.Keys,
		stats:     cfg.Stats,
		appName:   appName,
		extStatus: map[string]string{},
		footer:    shell.FooterData{Cwd: cfg.Cwd, Home: cfg.Home, GitBranch: cfg.GitBranch},
	}
	sh.SetSession("", cfg.Cwd)
	w.pushFooter()
	return w
}

// WindowTitle returns the current terminal title as readable state: the
// extension override when set, else "<app>[ - <session>] - <cwd base>". Todo 9
// maps it onto the View's WindowTitle field (charm.land/bubbletea/v2
// tea.go:141-143) — plain text only; bubbletea owns the OSC escape.
func (w *ShellWire) WindowTitle() string {
	if w.hasExtTitle {
		return w.extTitle
	}
	return shell.NormalTitle(w.appName, w.sessionName, w.footer.Cwd)
}

// HandleEvent applies one session event to the shell regions. It returns a
// tea.Cmd only for agent_end (the on-demand stats refresh); every other event
// mutates region state and returns nil.
func (w *ShellWire) HandleEvent(msg EventMsg) tea.Cmd {
	ev := msg.Event
	switch ev.Type {
	case "agent_start", "turn_start":
		w.dismissWelcome()
	case "agent_end":
		if w.stats != nil {
			return w.stats.SessionStats()
		}
	case "auto_retry_start":
		var p struct {
			Attempt     int   `json:"attempt"`
			MaxAttempts int   `json:"maxAttempts"`
			DelayMs     int64 `json:"delayMs"`
		}
		decodeEventPayload(ev, &p)
		w.retryDeadline = time.Now().Add(time.Duration(p.DelayMs) * time.Millisecond)
		w.sh.StatusStack().Set(shell.NewRetryStatus(w.th, p.Attempt, p.MaxAttempts, p.DelayMs, w.cancelHint()))
	case "auto_retry_end":
		w.clearStatus(shell.StatusRetry)
	case "compaction_start":
		w.setCompaction(ev)
	case "compaction_progress":
		if a := w.sh.StatusStack().Active(); a != nil && a.Kind() == shell.StatusCompaction {
			a.Advance()
		} else {
			w.setCompaction(ev) // recover a missed start so progress is visible
		}
	case "compaction_end":
		w.clearStatus(shell.StatusCompaction)
	case "session_info_changed":
		var p struct {
			Name string `json:"name"`
		}
		decodeEventPayload(ev, &p)
		w.applySessionName(p.Name)
		w.pushFooter()
	case "thinking_level_changed":
		var p struct {
			Level string `json:"level"`
		}
		decodeEventPayload(ev, &p)
		w.footer.ThinkingLevel = p.Level
		w.pushFooter()
	}
	return nil
}

// HandleBootstrap seeds the footer + title from the get_state /
// get_available_models fan-in. Failed sub-responses are skipped — the wire
// keeps whatever state it already has (BootstrapMsg.Err surfacing is the
// transcript's job, not the footer's).
func (w *ShellWire) HandleBootstrap(msg BootstrapMsg) {
	if msg.State.Success {
		var st bridge.RPCSessionState
		if json.Unmarshal(msg.State.Data, &st) == nil {
			w.applyState(st)
		}
	}
	if msg.Models.Success {
		var data struct {
			Models []struct {
				Provider string `json:"provider"`
			} `json:"models"`
		}
		if json.Unmarshal(msg.Models.Data, &data) == nil {
			seen := map[string]bool{}
			for _, m := range data.Models {
				seen[m.Provider] = true
			}
			w.footer.ProviderCount = len(seen)
		}
	}
	w.pushFooter()
}

// applyState folds a get_state snapshot into the footer + title state.
func (w *ShellWire) applyState(st bridge.RPCSessionState) {
	w.applySessionName(st.SessionName)
	w.footer.ThinkingLevel = string(st.ThinkingLevel)
	w.footer.AutoCompact = st.AutoCompactionEnabled
	if len(st.Model) > 0 {
		var m struct {
			ID            string `json:"id"`
			Provider      string `json:"provider"`
			Reasoning     bool   `json:"reasoning"`
			ContextWindow int    `json:"contextWindow"`
		}
		if json.Unmarshal(st.Model, &m) == nil {
			w.footer.ModelID = m.ID
			w.footer.Provider = m.Provider
			w.footer.ModelReasons = m.Reasoning
			if w.footer.ContextWindow == 0 {
				w.footer.ContextWindow = m.ContextWindow
			}
		}
	}
	if st.MessageCount > 0 {
		w.dismissWelcome() // resumed session: already past its first turn
	}
}

// applyModelResult folds a set_model / cycle_model response payload (the model
// object, or null when a cycle had nowhere to go) into the footer model
// segment. A null/undecodable payload keeps the current model.
func (w *ShellWire) applyModelResult(data json.RawMessage) {
	var m struct {
		ID            string `json:"id"`
		Provider      string `json:"provider"`
		Reasoning     bool   `json:"reasoning"`
		ContextWindow int    `json:"contextWindow"`
	}
	if len(data) == 0 || json.Unmarshal(data, &m) != nil || m.ID == "" {
		return
	}
	w.footer.ModelID = m.ID
	w.footer.Provider = m.Provider
	w.footer.ModelReasons = m.Reasoning
	if m.ContextWindow > 0 {
		w.footer.ContextWindow = m.ContextWindow
	}
	w.pushFooter()
}

// HandleCommandResult consumes the wire-owned command round-trips: session
// stats (the command HandleEvent returned for agent_end) into the footer
// token/cost/context numbers, and model switches (set_model / cycle_model —
// no RPC event carries model changes, so the response is the only signal)
// into the footer model segment. Reports whether the message was consumed.
func (w *ShellWire) HandleCommandResult(msg CommandResultMsg) bool {
	if msg.Command == "set_model" || msg.Command == "cycle_model" {
		if msg.Err == nil && msg.Response.Success {
			w.applyModelResult(msg.Response.Data)
		}
		return true
	}
	if msg.Command != "get_session_stats" {
		return false
	}
	if msg.Err != nil || !msg.Response.Success {
		return true // a failed refresh keeps the previous numbers
	}
	var stats struct {
		Tokens struct {
			Input      int `json:"input"`
			Output     int `json:"output"`
			CacheRead  int `json:"cacheRead"`
			CacheWrite int `json:"cacheWrite"`
		} `json:"tokens"`
		Cost         float64 `json:"cost"`
		ContextUsage *struct {
			Tokens        *int     `json:"tokens"`
			ContextWindow int      `json:"contextWindow"`
			Percent       *float64 `json:"percent"`
		} `json:"contextUsage"`
	}
	if json.Unmarshal(msg.Response.Data, &stats) != nil {
		return true
	}
	w.footer.TokensInput = stats.Tokens.Input
	w.footer.TokensOutput = stats.Tokens.Output
	w.footer.CacheRead = stats.Tokens.CacheRead
	w.footer.CacheWrite = stats.Tokens.CacheWrite
	w.footer.Cost = stats.Cost
	if cu := stats.ContextUsage; cu != nil {
		if cu.ContextWindow > 0 {
			w.footer.ContextWindow = cu.ContextWindow
		}
		w.footer.ContextPctKnown = cu.Percent != nil
		w.footer.ContextPct = 0
		if cu.Percent != nil {
			w.footer.ContextPct = *cu.Percent
		}
		switch {
		case cu.Tokens != nil:
			w.footer.ContextTokens = *cu.Tokens
		case cu.Percent != nil:
			// footer.ts estimate: round(window * percent / 100).
			w.footer.ContextTokens = int(float64(w.footer.ContextWindow)*(*cu.Percent)/100 + 0.5)
		default:
			w.footer.ContextTokens = 0 // unknown until the next response
		}
	}
	w.pushFooter()
	return true
}

// AdvanceStatus advances the active status spinner one frame and, for the
// retry countdown, re-derives the remaining seconds (ceil) from the
// event-seeded deadline. The app's existing render tick drives it — the wire
// owns no timer of its own.
func (w *ShellWire) AdvanceStatus(now time.Time) {
	stack := w.sh.StatusStack()
	stack.Advance()
	a := stack.Active()
	if a == nil || a.Kind() != shell.StatusRetry {
		return
	}
	remaining := w.retryDeadline.Sub(now)
	if remaining < 0 {
		remaining = 0
	}
	a.SetRemainingSeconds(int((remaining + 999*time.Millisecond) / time.Second))
}

// SetExtensionStatus installs (or replaces) a keyed footer status segment.
func (w *ShellWire) SetExtensionStatus(key, text string) {
	w.extStatus[key] = text
	w.pushExtStatus()
}

// ClearExtensionStatus removes a keyed footer status segment.
func (w *ShellWire) ClearExtensionStatus(key string) {
	delete(w.extStatus, key)
	w.pushExtStatus()
}

// SetExtensionWidget installs a keyed widget block on one editor side. A key
// lives in exactly one area, so re-placing moves it; empty/nil lines clear it.
func (w *ShellWire) SetExtensionWidget(key string, lines []string, placement WidgetPlacement) {
	w.sh.WidgetAbove().Clear(key)
	w.sh.WidgetBelow().Clear(key)
	if len(lines) == 0 {
		return
	}
	if placement == WidgetBelowEditor {
		w.sh.WidgetBelow().Set(key, lines)
		return
	}
	w.sh.WidgetAbove().Set(key, lines)
}

// SetExtensionTitle overrides the terminal title (interactive-mode
// extensionTerminalTitle precedence) until ClearExtensionTitle restores the
// normal title.
func (w *ShellWire) SetExtensionTitle(title string) {
	w.extTitle, w.hasExtTitle = title, true
}

// ClearExtensionTitle drops the extension title override.
func (w *ShellWire) ClearExtensionTitle() {
	w.extTitle, w.hasExtTitle = "", false
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

func (w *ShellWire) dismissWelcome() {
	if w.turnSeen {
		return
	}
	w.turnSeen = true
	w.sh.DismissWelcome()
}

func (w *ShellWire) applySessionName(name string) {
	w.sessionName = name
	w.footer.SessionName = name
	w.sh.SetSession(name, w.footer.Cwd)
}

// cancelHint resolves the app.interrupt key display for status messages.
func (w *ShellWire) cancelHint() string {
	if w.keys == nil {
		return ""
	}
	return firstKey(w.keys, actionInterrupt)
}

// clearStatus clears the stack only when the active indicator matches kind, so
// an unrelated end event never wipes another surface's status.
func (w *ShellWire) clearStatus(kind shell.StatusKind) {
	if a := w.sh.StatusStack().Active(); a != nil && a.Kind() == kind {
		w.sh.StatusStack().Clear()
	}
}

func (w *ShellWire) setCompaction(ev bridge.Event) {
	var p struct {
		Reason string `json:"reason"`
	}
	decodeEventPayload(ev, &p)
	w.sh.StatusStack().Set(shell.NewCompactionStatus(w.th, compactionReason(p.Reason), w.cancelHint()))
}

// compactionReason maps the wire reason strings (extensions/types.ts
// CompactionReason) onto the shell enum; unknown reasons fall back to manual.
func compactionReason(reason string) shell.CompactionReason {
	switch reason {
	case "threshold":
		return shell.CompactionThreshold
	case "overflow":
		return shell.CompactionOverflow
	case "pre_prompt":
		return shell.CompactionPrePrompt
	case "branch":
		return shell.CompactionBranch
	case "extension":
		return shell.CompactionExtension
	default:
		return shell.CompactionManual
	}
}

// decodeEventPayload best-effort decodes an event's raw line into dst; a
// malformed payload leaves dst zero-valued (the UI degrades, never panics).
func decodeEventPayload(ev bridge.Event, dst any) {
	if len(ev.Payload) == 0 {
		return
	}
	_ = json.Unmarshal(ev.Payload, dst)
}

func (w *ShellWire) pushFooter() { w.sh.Footer().SetData(w.footer) }

// pushExtStatus hands the footer a copy so later mutations cannot race a
// render of the previously-set map.
func (w *ShellWire) pushExtStatus() {
	if len(w.extStatus) == 0 {
		w.sh.Footer().SetExtensionStatuses(nil)
		return
	}
	cp := make(map[string]string, len(w.extStatus))
	for k, v := range w.extStatus {
		cp[k] = v
	}
	w.sh.Footer().SetExtensionStatuses(cp)
}
