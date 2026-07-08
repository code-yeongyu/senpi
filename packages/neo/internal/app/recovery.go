package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
)

// Bounded-recovery defaults: the reconnect loop NEVER retries forever — after
// MaxAttempts it surfaces a fatal quit signal instead.
const (
	defaultRecoveryMaxAttempts = 5
	defaultRecoveryBackoffMin  = 250 * time.Millisecond
	defaultRecoveryBackoffMax  = 2 * time.Second
)

// One-line notices the recovery loop exposes for rendering. abortedTurnNotice
// follows the master task-17 semantics: a turn in flight when the connection
// dropped is shown ABORTED — there is no live-reattach lease, so its streaming
// output is gone even though the daemon may have finished it.
const (
	abortedTurnNotice   = "connection lost; the in-flight turn was aborted"
	isolatedFatalNotice = "senpi backend exited unexpectedly; restart senpi --neo to continue"
	daemonFatalNotice   = "could not reconnect to the senpi daemon; restart senpi --neo to continue"
)

// RecoveryPhase is the connection state the UI renders.
type RecoveryPhase int

const (
	// RecoveryConnected: attached to a live client (also the initial state).
	RecoveryConnected RecoveryPhase = iota
	// RecoveryReconnecting: the connection dropped; the bounded loop is running.
	RecoveryReconnecting
	// RecoveryFatal: the loop gave up (retry cap) or the isolated child exited.
	RecoveryFatal
)

func (p RecoveryPhase) String() string {
	switch p {
	case RecoveryConnected:
		return "connected"
	case RecoveryReconnecting:
		return "reconnecting"
	case RecoveryFatal:
		return "fatal"
	default:
		return "unknown"
	}
}

// ResumedEntry is one persisted session entry from get_entries, delivered raw:
// recovery does not interpret entries — the transcript layer owns decoding.
type ResumedEntry struct {
	ID   string
	Type string
	Raw  json.RawMessage
}

// TranscriptReplayer is the narrow replay contract the recovery loop drives; the
// transcript wiring implements it. MarkTurnAborted is invoked on the update loop
// (inside HandleClientClosed); ReplayEntries runs on the recovery command's
// goroutine, so implementations must be safe to call from any goroutine (hand
// off via program.Send or internal locking).
type TranscriptReplayer interface {
	// MarkTurnAborted renders the in-flight turn as aborted with a one-line notice.
	MarkTurnAborted(notice string)
	// ReplayEntries replays resumed entries (oldest first) into the transcript.
	ReplayEntries(entries []ResumedEntry)
}

// ReattachFunc re-establishes the daemon transport after a drop, resuming the
// given session id (the session live before the drop) so the respawned daemon's
// worker loads the SAME session from disk rather than auto-creating a new one.
// An empty sessionID means "no specific session captured yet" (falls back to the
// original launch options). Production uses DaemonReattach; tests inject scripted
// transports.
type ReattachFunc func(sessionID string) (bridge.Transport, error)

// RecoveryResumedMsg is emitted after a successful reconnect + resume. The old
// client is dead: the consumer must adopt Client (rewire the session adapter).
type RecoveryResumedMsg struct {
	// Client is the fresh RPC client over the reattached transport.
	Client *bridge.Client
	// LeafID is the entry id the resume reloaded up to (next resume's `since`).
	LeafID string
	// Attempts is how many reattach attempts this recovery consumed.
	Attempts int
	// Aborted reports whether a turn was in flight when the drop happened.
	Aborted bool
}

// RecoveryFatalMsg is the quit signal: the recovery loop gave up (retry cap) or
// the isolated child exited. Todo 9 maps it to tea.Quit + os.Exit(ExitCode); the
// launcher re-raises the code.
type RecoveryFatalMsg struct {
	// Err is the recorded exit/reconnect error (wraps bridge.ErrClientClosed for
	// an isolated child exit).
	Err error
	// Notice is the one-line fatal notice to render before exiting.
	Notice string
	// ExitCode is the process exit code (always 1).
	ExitCode int
}

// RecoverySnapshot is an immutable view of the recovery state for the UI.
type RecoverySnapshot struct {
	Phase RecoveryPhase
	// InFlightTurnAborted is set when a disconnect happened while a turn was in
	// flight — that turn is rendered as aborted (no live-reattach lease).
	InFlightTurnAborted bool
	// LastEntryID is the id the next resume passes as get_entries{since}.
	LastEntryID string
	// Reconnects counts successful recoveries.
	Reconnects int
	// Notice is the current aborted/fatal one-line notice ("" when none).
	Notice string
	// ExitCode is non-zero only in the fatal phase (always 1 there).
	ExitCode int
}

// RecoveryConfig configures the app-layer recovery loop.
type RecoveryConfig struct {
	// Mode selects the drop semantics: TransportDaemon (the zero value) drops
	// reconnect + resume; a TransportIsolated child exit is fatal.
	Mode bridge.TransportMode
	// Replay is the transcript sink for aborted notices + resumed entries. A nil
	// Replay is valid (headless): state is still tracked via Snapshot.
	Replay TranscriptReplayer
	// Reattach re-establishes the daemon transport; required in daemon mode
	// (production: DaemonReattach). Ignored in isolated mode.
	Reattach ReattachFunc
	// MaxAttempts caps reattach attempts per recovery (default 5); never infinite.
	MaxAttempts int
	// BackoffMin/BackoffMax bound the doubling pause between attempts
	// (defaults 250ms / 2s).
	BackoffMin time.Duration
	BackoffMax time.Duration
	// ResumeTimeout bounds each resume RPC (default bridge.DefaultRequestTimeout).
	ResumeTimeout time.Duration
	// Sleep pauses between attempts. Defaults to time.Sleep; tests inject a
	// recorder so the capped schedule is asserted without real waiting.
	Sleep func(time.Duration)
}

// Recovery owns the app-layer reconnect/resume/respawn loop (plan todo 8). On a
// ClientClosedMsg it either runs the bounded daemon recovery (reconnect — or
// respawn via the existing bridge attach-or-spawn path — then resume the SAME
// session) or, in isolated mode, surfaces the fatal exit-1 quit signal. It never
// kills the daemon: the idle timer owns that lifecycle.
type Recovery struct {
	mode          bridge.TransportMode
	replay        TranscriptReplayer
	reattach      ReattachFunc
	maxAttempts   int
	backoffMin    time.Duration
	backoffMax    time.Duration
	resumeTimeout time.Duration
	sleep         func(time.Duration)

	mu          sync.Mutex
	phase       RecoveryPhase
	turnLive    bool
	abortedTurn bool
	lastEntryID string
	sessionID   string
	reconnects  int
	notice      string
	exitCode    int
}

// NewRecovery builds a Recovery in the connected phase, applying the bounded
// defaults for any zero config value.
func NewRecovery(cfg RecoveryConfig) *Recovery {
	r := &Recovery{
		mode:          cfg.Mode,
		replay:        cfg.Replay,
		reattach:      cfg.Reattach,
		maxAttempts:   cfg.MaxAttempts,
		backoffMin:    cfg.BackoffMin,
		backoffMax:    cfg.BackoffMax,
		resumeTimeout: cfg.ResumeTimeout,
		sleep:         cfg.Sleep,
		phase:         RecoveryConnected,
	}
	if r.replay == nil {
		r.replay = noopReplayer{}
	}
	if r.maxAttempts <= 0 {
		r.maxAttempts = defaultRecoveryMaxAttempts
	}
	if r.backoffMin <= 0 {
		r.backoffMin = defaultRecoveryBackoffMin
	}
	if r.backoffMax <= 0 {
		r.backoffMax = defaultRecoveryBackoffMax
	}
	if r.backoffMax < r.backoffMin {
		r.backoffMax = r.backoffMin
	}
	if r.resumeTimeout <= 0 {
		r.resumeTimeout = bridge.DefaultRequestTimeout
	}
	if r.sleep == nil {
		r.sleep = time.Sleep
	}
	return r
}

// attachOrSpawn indirects bridge.AttachOrSpawn so tests can capture the resolved
// AttachConfig (e.g. the injected session id) without a real daemon. Production
// binds it to the real attach-or-spawn client.
var attachOrSpawn = bridge.AttachOrSpawn

// SetAttachOrSpawnForTest swaps the attach-or-spawn indirection and returns a
// restore func. Test-only seam (exported for the external app_test package).
func SetAttachOrSpawnForTest(fn func(bridge.AttachConfig) (*bridge.DaemonConn, error)) func() {
	prev := attachOrSpawn
	attachOrSpawn = fn
	return func() { attachOrSpawn = prev }
}

// DaemonReattach builds the production ReattachFunc from the original
// attachment's metadata (bridge.ConnectResult.Daemon). bridge.AttachOrSpawn is
// the existing transport-level recovery — reconnect when the daemon is alive
// (including the lost-record self-heal) and respawn via the daemon spawn path
// when it is dead — so the app layer wraps it rather than duplicating any of it.
func DaemonReattach(conn *bridge.DaemonConn, capabilities []string, options bridge.NeoRuntimeOptions, timeout time.Duration) ReattachFunc {
	return func(sessionID string) (bridge.Transport, error) {
		// Resume the SAME session: pin the reattach's runtime options to the live
		// session id so the respawned daemon's worker loads that session from disk
		// (`--session-id <id>` "creating it if missing") instead of auto-creating a
		// new one — without which resume's get_entries{since:<old-leaf>} runs against
		// a fresh empty session and fails on every attempt.
		opts := options
		if sessionID != "" {
			id := sessionID
			opts.SessionID = &id
		}
		fresh, err := attachOrSpawn(bridge.AttachConfig{
			AgentDir:       conn.AgentDir,
			Cwd:            conn.Cwd,
			Capabilities:   capabilities,
			RuntimeOptions: opts,
			Timeout:        timeout,
		})
		if err != nil {
			return nil, err
		}
		return fresh.Transport, nil
	}
}

// MarkTurnInFlight records that a turn is running: a disconnect before it
// completes is rendered as an aborted turn (never silently reattached).
func (r *Recovery) MarkTurnInFlight() {
	r.mu.Lock()
	r.turnLive = true
	r.mu.Unlock()
}

// MarkTurnComplete clears the in-flight marker (a turn that finished normally is
// not aborted by a later disconnect).
func (r *Recovery) MarkTurnComplete() {
	r.mu.Lock()
	r.turnLive = false
	r.mu.Unlock()
}

// NoteEntryID records the newest persisted entry id observed on the event
// stream; the next resume passes it as get_entries{since} (efficient reload).
func (r *Recovery) NoteEntryID(id string) {
	if id == "" {
		return
	}
	r.mu.Lock()
	r.lastEntryID = id
	r.mu.Unlock()
}

// NoteSessionID records the active session id (from bootstrap get_state and
// session_info_changed events). A daemon respawn reattaches resuming this exact
// session so the reloaded entries match the pre-drop transcript.
func (r *Recovery) NoteSessionID(id string) {
	if id == "" {
		return
	}
	r.mu.Lock()
	r.sessionID = id
	r.mu.Unlock()
}

// Snapshot returns the current recovery state.
func (r *Recovery) Snapshot() RecoverySnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return RecoverySnapshot{
		Phase:               r.phase,
		InFlightTurnAborted: r.abortedTurn,
		LastEntryID:         r.lastEntryID,
		Reconnects:          r.reconnects,
		Notice:              r.notice,
		ExitCode:            r.exitCode,
	}
}

// HandleClientClosed reacts to a dropped client. Daemon mode marks the in-flight
// turn aborted immediately and returns the bounded reconnect+resume command;
// isolated mode returns the fatal exit-1 quit signal. Duplicate drop reports
// (already recovering, or already fatal) return nil.
func (r *Recovery) HandleClientClosed(msg ClientClosedMsg) tea.Cmd {
	closeErr := msg.Err
	if closeErr == nil {
		closeErr = bridge.ErrClientClosed
	}

	r.mu.Lock()
	if r.phase != RecoveryConnected {
		r.mu.Unlock()
		return nil
	}
	aborted := r.turnLive
	r.turnLive = false

	if r.mode == bridge.TransportIsolated {
		r.phase = RecoveryFatal
		r.abortedTurn = r.abortedTurn || aborted
		r.notice = isolatedFatalNotice
		r.exitCode = 1
		r.mu.Unlock()
		fatal := RecoveryFatalMsg{
			Err:      fmt.Errorf("isolated backend exited: %w", closeErr),
			Notice:   isolatedFatalNotice,
			ExitCode: 1,
		}
		return func() tea.Msg { return fatal }
	}

	r.phase = RecoveryReconnecting
	if aborted {
		r.abortedTurn = true
		r.notice = abortedTurnNotice
	}
	lastEntry := r.lastEntryID
	sessionID := r.sessionID
	r.mu.Unlock()

	if aborted {
		r.replay.MarkTurnAborted(abortedTurnNotice)
	}
	return func() tea.Msg { return r.reconnectAndResume(lastEntry, sessionID, aborted) }
}

// reconnectAndResume runs the bounded daemon recovery: reattach (the bridge path
// reconnects or respawns), then resume the SAME session and replay its entries.
// A failed attempt backs off (doubling, capped at backoffMax) until maxAttempts,
// then the failure surfaces as the fatal quit signal.
func (r *Recovery) reconnectAndResume(lastEntry, sessionID string, aborted bool) tea.Msg {
	if r.reattach == nil {
		return r.fail(errors.New("recovery: daemon mode requires a Reattach func"))
	}

	backoff := r.backoffMin
	var lastErr error
	for attempt := 1; attempt <= r.maxAttempts; attempt++ {
		if attempt > 1 {
			r.sleep(backoff)
			backoff *= 2
			if backoff > r.backoffMax {
				backoff = r.backoffMax
			}
		}

		transport, err := r.reattach(sessionID)
		if err != nil {
			lastErr = err
			continue
		}
		client := bridge.NewClient(transport)
		leafID, entries, rerr := resumeSession(client, lastEntry, r.resumeTimeout)
		if rerr != nil {
			lastErr = rerr
			// Close only this half-dead attachment — never the daemon itself
			// (the idle timer owns the daemon's lifecycle).
			_ = client.Close()
			continue
		}

		r.replay.ReplayEntries(entries)
		r.mu.Lock()
		r.phase = RecoveryConnected
		r.reconnects++
		if leafID != "" {
			r.lastEntryID = leafID
		}
		r.mu.Unlock()
		return RecoveryResumedMsg{Client: client, LeafID: leafID, Attempts: attempt, Aborted: aborted}
	}
	return r.fail(fmt.Errorf("recovery: gave up after %d attempts: %w", r.maxAttempts, lastErr))
}

// fail records the fatal state and builds the quit signal.
func (r *Recovery) fail(err error) tea.Msg {
	r.mu.Lock()
	r.phase = RecoveryFatal
	r.notice = daemonFatalNotice
	r.exitCode = 1
	r.mu.Unlock()
	return RecoveryFatalMsg{Err: err, Notice: daemonFatalNotice, ExitCode: 1}
}

// resumeSession replays the resume contract onto a fresh client: get_state FIRST
// (confirms the runtime serves the same session), then get_entries{since:
// <lastEntry>} (rpc-types.ts) for the efficient reload. It returns the reloaded
// leaf id and the raw entries for the transcript replay.
func resumeSession(client *bridge.Client, since string, timeout time.Duration) (string, []ResumedEntry, error) {
	state, err := client.Request(bridge.Command{Type: "get_state"}, timeout)
	if err != nil {
		return "", nil, fmt.Errorf("resume get_state: %w", err)
	}
	if !state.Success {
		return "", nil, fmt.Errorf("resume get_state failed: %s", state.Error)
	}

	fields := map[string]any{}
	if since != "" {
		fields["since"] = since
	}
	resp, err := client.Request(bridge.Command{Type: "get_entries", Fields: fields}, timeout)
	if err != nil {
		return "", nil, fmt.Errorf("resume get_entries: %w", err)
	}
	if !resp.Success {
		return "", nil, fmt.Errorf("resume get_entries failed: %s", resp.Error)
	}

	var data struct {
		Entries []json.RawMessage `json:"entries"`
		LeafID  string            `json:"leafId"`
	}
	if uerr := json.Unmarshal(resp.Data, &data); uerr != nil {
		return "", nil, fmt.Errorf("resume get_entries decode: %w", uerr)
	}
	entries := make([]ResumedEntry, 0, len(data.Entries))
	for _, raw := range data.Entries {
		var head struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &head) // best-effort: Raw is preserved either way
		entries = append(entries, ResumedEntry{ID: head.ID, Type: head.Type, Raw: raw})
	}
	return data.LeafID, entries, nil
}

// noopReplayer is installed when no transcript sink is configured (headless
// harness); recovery state is still tracked and surfaced via Snapshot.
type noopReplayer struct{}

func (noopReplayer) MarkTurnAborted(string)       {}
func (noopReplayer) ReplayEntries([]ResumedEntry) {}
