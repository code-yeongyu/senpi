package app_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
)

// ---------------------------------------------------------------------------
// Test doubles (fakeTransport is shared with session_test.go — same package)
// ---------------------------------------------------------------------------

// resumeScript is a scripted fake RPC server for the recovery loop: it answers
// get_state / get_entries over a fakeTransport, records the request order and
// the get_entries `since` value, and can DROP the transport after a fixed number
// of answered lines (a mid-resume disconnect — the "drops after N lines" case).
type resumeScript struct {
	ft        *fakeTransport
	leafID    string
	entries   string // raw JSON array for the get_entries data
	dropAfter int    // close the transport after this many responses (0 = never)
	mu        sync.Mutex
	order     []string
	since     []string
}

func newResumeScript(leafID, entries string, dropAfter int) *resumeScript {
	s := &resumeScript{ft: newFakeTransport(), leafID: leafID, entries: entries, dropAfter: dropAfter}
	go s.serve()
	return s
}

func (s *resumeScript) serve() {
	answered := 0
	for {
		var raw []byte
		select {
		case raw = <-s.ft.fromCli:
		case <-s.ft.closed:
			return
		}
		var cmd struct {
			ID    string `json:"id"`
			Type  string `json:"type"`
			Since string `json:"since"`
		}
		if json.Unmarshal(raw, &cmd) != nil {
			continue
		}
		s.mu.Lock()
		s.order = append(s.order, cmd.Type)
		if cmd.Type == "get_entries" {
			s.since = append(s.since, cmd.Since)
		}
		s.mu.Unlock()

		var resp string
		switch cmd.Type {
		case "get_state":
			resp = fmt.Sprintf(`{"id":%q,"type":"response","command":"get_state","success":true,"data":{"sessionId":"sess-1","thinkingLevel":"off","isStreaming":false,"isCompacting":false,"steeringMode":"all","followUpMode":"all","autoCompactionEnabled":true,"messageCount":2,"pendingMessageCount":0}}`, cmd.ID)
		case "get_entries":
			resp = fmt.Sprintf(`{"id":%q,"type":"response","command":"get_entries","success":true,"data":{"entries":%s,"leafId":%q}}`, cmd.ID, s.entries, s.leafID)
		default:
			resp = fmt.Sprintf(`{"id":%q,"type":"response","command":%q,"success":true}`, cmd.ID, cmd.Type)
		}
		select {
		case s.ft.toClient <- []byte(resp):
		case <-s.ft.closed:
			return
		}
		answered++
		if s.dropAfter > 0 && answered >= s.dropAfter {
			_ = s.ft.Close()
			return
		}
	}
}

func (s *resumeScript) requestOrder() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.order...)
}

func (s *resumeScript) sinceValues() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.since...)
}

// fakeReplay records the narrow transcript-replay calls the recovery loop makes.
type fakeReplay struct {
	mu       sync.Mutex
	aborted  []string
	replayed [][]app.ResumedEntry
}

func (f *fakeReplay) MarkTurnAborted(notice string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.aborted = append(f.aborted, notice)
}

func (f *fakeReplay) ReplayEntries(entries []app.ResumedEntry) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replayed = append(f.replayed, entries)
}

func (f *fakeReplay) abortedNotices() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.aborted...)
}

func (f *fakeReplay) replayedBatches() [][]app.ResumedEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]app.ResumedEntry(nil), f.replayed...)
}

// sleepRecorder captures the backoff schedule without real waiting.
type sleepRecorder struct {
	mu    sync.Mutex
	slept []time.Duration
}

func (s *sleepRecorder) sleep(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.slept = append(s.slept, d)
}

func (s *sleepRecorder) durations() []time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Duration(nil), s.slept...)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestRecoveryDaemonResumesSameSession asserts a daemon-mode drop reconnects and
// resumes the SAME session: get_state is issued BEFORE get_entries, get_entries
// carries since=<last entry id>, the resumed entries are replayed through the
// narrow replay interface, and the in-flight turn is rendered aborted at drop
// time (no live-reattach lease).
func TestRecoveryDaemonResumesSameSession(t *testing.T) {
	script := newResumeScript("e9", `[{"id":"e2","type":"message"},{"id":"e3","type":"message"}]`, 0)
	replay := &fakeReplay{}
	slept := &sleepRecorder{}

	rec := app.NewRecovery(app.RecoveryConfig{
		Mode:        bridge.TransportDaemon,
		Replay:      replay,
		Reattach:    func(string) (bridge.Transport, error) { return script.ft, nil },
		MaxAttempts: 3,
		BackoffMin:  time.Millisecond,
		BackoffMax:  4 * time.Millisecond,
		Sleep:       slept.sleep,
	})
	rec.NoteEntryID("e1")
	rec.MarkTurnInFlight()

	cmd := rec.HandleClientClosed(app.ClientClosedMsg{Err: bridge.ErrClientClosed})
	if cmd == nil {
		t.Fatalf("daemon drop must start a recovery command")
	}

	// The aborted notice renders immediately at drop time, before reconnecting.
	if notices := replay.abortedNotices(); len(notices) != 1 || notices[0] == "" {
		t.Fatalf("in-flight turn must be marked aborted at drop time, got %#v", notices)
	}
	// A duplicate drop report mid-recovery must not start a second loop.
	if dup := rec.HandleClientClosed(app.ClientClosedMsg{Err: bridge.ErrClientClosed}); dup != nil {
		t.Fatalf("duplicate drop report must be ignored while recovering")
	}

	msg := cmd()
	resumed, ok := msg.(app.RecoveryResumedMsg)
	if !ok {
		t.Fatalf("want RecoveryResumedMsg, got %T (%v)", msg, msg)
	}
	if resumed.Client == nil {
		t.Fatalf("resumed message must carry the fresh client to adopt")
	}
	if resumed.LeafID != "e9" {
		t.Fatalf("resume must reload the leaf id, got %q", resumed.LeafID)
	}
	if !resumed.Aborted {
		t.Fatalf("resumed message must report the aborted in-flight turn")
	}
	if resumed.Attempts != 1 {
		t.Fatalf("clean reconnect should take one attempt, got %d", resumed.Attempts)
	}

	order := script.requestOrder()
	if len(order) != 2 || order[0] != "get_state" || order[1] != "get_entries" {
		t.Fatalf("resume must issue get_state BEFORE get_entries, got %v", order)
	}
	if since := script.sinceValues(); len(since) != 1 || since[0] != "e1" {
		t.Fatalf("get_entries must carry since=<last entry id>, got %v", since)
	}

	batches := replay.replayedBatches()
	if len(batches) != 1 || len(batches[0]) != 2 {
		t.Fatalf("resumed entries must be replayed once, got %#v", batches)
	}
	if batches[0][0].ID != "e2" || batches[0][1].ID != "e3" {
		t.Fatalf("entries replayed out of order: %#v", batches[0])
	}
	if batches[0][0].Type != "message" || len(batches[0][0].Raw) == 0 {
		t.Fatalf("replayed entry must keep type + raw payload: %#v", batches[0][0])
	}

	snap := rec.Snapshot()
	if snap.Phase != app.RecoveryConnected {
		t.Fatalf("recovery must end reconnected, got %v", snap.Phase)
	}
	if !snap.InFlightTurnAborted {
		t.Fatalf("snapshot must record the aborted in-flight turn: %+v", snap)
	}
	if snap.LastEntryID != "e9" {
		t.Fatalf("next resume must use the reloaded leaf id, got %q", snap.LastEntryID)
	}
	if snap.Reconnects != 1 {
		t.Fatalf("snapshot must count the reconnect, got %d", snap.Reconnects)
	}
	if len(slept.durations()) != 0 {
		t.Fatalf("clean first-attempt reconnect must not back off, slept %v", slept.durations())
	}
}

// TestRecoveryDaemonDropMidResumeRetries asserts a transport that drops after N
// answered lines fails that attempt and the loop retries (with one backoff
// pause) onto a fresh transport that completes the full resume sequence.
func TestRecoveryDaemonDropMidResumeRetries(t *testing.T) {
	dropping := newResumeScript("e9", `[]`, 1) // answers one line, then drops
	healthy := newResumeScript("e9", `[{"id":"e2","type":"message"}]`, 0)
	replay := &fakeReplay{}
	slept := &sleepRecorder{}

	attempt := 0
	rec := app.NewRecovery(app.RecoveryConfig{
		Mode:   bridge.TransportDaemon,
		Replay: replay,
		Reattach: func(string) (bridge.Transport, error) {
			attempt++
			if attempt == 1 {
				return dropping.ft, nil
			}
			return healthy.ft, nil
		},
		MaxAttempts: 3,
		BackoffMin:  time.Millisecond,
		BackoffMax:  4 * time.Millisecond,
		Sleep:       slept.sleep,
	})

	cmd := rec.HandleClientClosed(app.ClientClosedMsg{Err: bridge.ErrClientClosed})
	if cmd == nil {
		t.Fatalf("daemon drop must start a recovery command")
	}
	msg := cmd()
	resumed, ok := msg.(app.RecoveryResumedMsg)
	if !ok {
		t.Fatalf("want RecoveryResumedMsg, got %T (%v)", msg, msg)
	}
	if resumed.Attempts != 2 {
		t.Fatalf("mid-resume drop must consume one attempt then retry, got %d", resumed.Attempts)
	}
	if resumed.Aborted {
		t.Fatalf("no turn was in flight; resumed must not report an abort")
	}
	if got := slept.durations(); !reflect.DeepEqual(got, []time.Duration{time.Millisecond}) {
		t.Fatalf("one retry must pause once at BackoffMin, slept %v", got)
	}
	order := healthy.requestOrder()
	if len(order) != 2 || order[0] != "get_state" || order[1] != "get_entries" {
		t.Fatalf("retried resume must issue get_state BEFORE get_entries, got %v", order)
	}
	// No entry id was ever observed, so the retried get_entries omits `since`.
	if since := healthy.sinceValues(); len(since) != 1 || since[0] != "" {
		t.Fatalf("first-ever resume must omit since, got %v", since)
	}
}

// TestRecoveryDaemonRetriesAreCapped asserts the reconnect loop is bounded: the
// backoff doubles from BackoffMin and is capped at BackoffMax, the attempts stop
// at MaxAttempts (never infinite), and the failure surfaces as a fatal quit
// signal with exit code 1.
func TestRecoveryDaemonRetriesAreCapped(t *testing.T) {
	replay := &fakeReplay{}
	slept := &sleepRecorder{}

	attempts := 0
	rec := app.NewRecovery(app.RecoveryConfig{
		Mode:   bridge.TransportDaemon,
		Replay: replay,
		Reattach: func(string) (bridge.Transport, error) {
			attempts++
			return nil, errors.New("daemon unreachable")
		},
		MaxAttempts: 4,
		BackoffMin:  10 * time.Millisecond,
		BackoffMax:  20 * time.Millisecond,
		Sleep:       slept.sleep,
	})

	cmd := rec.HandleClientClosed(app.ClientClosedMsg{Err: bridge.ErrClientClosed})
	if cmd == nil {
		t.Fatalf("daemon drop must start a recovery command")
	}
	msg := cmd()
	fatal, ok := msg.(app.RecoveryFatalMsg)
	if !ok {
		t.Fatalf("capped retries must surface RecoveryFatalMsg, got %T (%v)", msg, msg)
	}
	if fatal.ExitCode != 1 {
		t.Fatalf("fatal exit code must be 1, got %d", fatal.ExitCode)
	}
	if fatal.Err == nil || fatal.Notice == "" {
		t.Fatalf("fatal must carry the error and a rendered notice: %+v", fatal)
	}
	if attempts != 4 {
		t.Fatalf("retries must stop at MaxAttempts=4, got %d", attempts)
	}
	want := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 20 * time.Millisecond}
	if got := slept.durations(); !reflect.DeepEqual(got, want) {
		t.Fatalf("backoff must double and cap at BackoffMax: got %v want %v", got, want)
	}
	snap := rec.Snapshot()
	if snap.Phase != app.RecoveryFatal || snap.ExitCode != 1 || snap.Notice == "" {
		t.Fatalf("snapshot must surface the fatal state: %+v", snap)
	}
	// Post-fatal drop reports must never restart the loop.
	if dup := rec.HandleClientClosed(app.ClientClosedMsg{Err: bridge.ErrClientClosed}); dup != nil {
		t.Fatalf("post-fatal drop report must be ignored")
	}
}

// TestRecoveryIsolatedExitIsFatalQuitSignal asserts an isolated child exit is
// terminal: no reconnect is attempted, the quit signal carries the recorded exit
// error and exit code 1 (todo 9 maps it to os.Exit; the launcher re-raises),
// and a fatal notice is exposed for rendering.
func TestRecoveryIsolatedExitIsFatalQuitSignal(t *testing.T) {
	rec := app.NewRecovery(app.RecoveryConfig{
		Mode: bridge.TransportIsolated,
		Reattach: func(string) (bridge.Transport, error) {
			t.Errorf("isolated mode must never reattach")
			return nil, errors.New("unreachable")
		},
	})

	cmd := rec.HandleClientClosed(app.ClientClosedMsg{Err: bridge.ErrClientClosed})
	if cmd == nil {
		t.Fatalf("isolated child exit must return the quit signal command")
	}
	msg := cmd()
	fatal, ok := msg.(app.RecoveryFatalMsg)
	if !ok {
		t.Fatalf("want RecoveryFatalMsg, got %T (%v)", msg, msg)
	}
	if fatal.ExitCode != 1 {
		t.Fatalf("isolated exit must map to exit code 1, got %d", fatal.ExitCode)
	}
	if !errors.Is(fatal.Err, bridge.ErrClientClosed) {
		t.Fatalf("fatal must carry the recorded exit error, got %v", fatal.Err)
	}
	if fatal.Notice == "" {
		t.Fatalf("fatal must expose a rendered notice")
	}

	snap := rec.Snapshot()
	if snap.Phase != app.RecoveryFatal {
		t.Fatalf("isolated exit must land in the fatal phase, got %v", snap.Phase)
	}
	if snap.ExitCode != 1 || snap.Notice == "" {
		t.Fatalf("snapshot must expose the exit-1 fatal state: %+v", snap)
	}
	if dup := rec.HandleClientClosed(app.ClientClosedMsg{Err: bridge.ErrClientClosed}); dup != nil {
		t.Fatalf("post-fatal drop report must be ignored")
	}
}

// TestRecoveryReattachResumesNotedSession asserts the recovery reattach carries
// the session id noted during normal operation, so a respawned daemon resumes
// the SAME session (regression: without it, the respawned worker auto-created a
// fresh session and resume's get_entries{since:<old-leaf>} failed to the cap).
func TestRecoveryReattachResumesNotedSession(t *testing.T) {
	script := newResumeScript("e9", `[{"id":"e2","type":"message"}]`, 0)
	var gotSession string
	rec := app.NewRecovery(app.RecoveryConfig{
		Mode:   bridge.TransportDaemon,
		Replay: &fakeReplay{},
		Reattach: func(sessionID string) (bridge.Transport, error) {
			gotSession = sessionID
			return script.ft, nil
		},
		MaxAttempts: 2,
		BackoffMin:  time.Millisecond,
		BackoffMax:  time.Millisecond,
		Sleep:       (&sleepRecorder{}).sleep,
	})
	rec.NoteEntryID("e1")
	rec.NoteSessionID("sess-abc")

	cmd := rec.HandleClientClosed(app.ClientClosedMsg{Err: bridge.ErrClientClosed})
	if cmd == nil {
		t.Fatalf("daemon drop must start a recovery command")
	}
	if _, ok := cmd().(app.RecoveryResumedMsg); !ok {
		t.Fatalf("expected a resume")
	}
	if gotSession != "sess-abc" {
		t.Fatalf("reattach must receive the noted session id, got %q", gotSession)
	}
}

// TestDaemonReattachInjectsSessionID asserts DaemonReattach pins the runtime
// options' session id to the resumed session before attach-or-spawn, so the
// respawned daemon worker loads that exact session (`--session-id`).
func TestDaemonReattachInjectsSessionID(t *testing.T) {
	var seen bridge.AttachConfig
	restore := app.SetAttachOrSpawnForTest(func(cfg bridge.AttachConfig) (*bridge.DaemonConn, error) {
		seen = cfg
		return nil, errors.New("stop after capture")
	})
	defer restore()

	reattach := app.DaemonReattach(&bridge.DaemonConn{AgentDir: "/a", Cwd: "/c"}, nil, bridge.NeoRuntimeOptions{}, time.Second)
	_, _ = reattach("sess-xyz")

	if seen.RuntimeOptions.SessionID == nil || *seen.RuntimeOptions.SessionID != "sess-xyz" {
		t.Fatalf("DaemonReattach must set RuntimeOptions.SessionID to the resumed session, got %v", seen.RuntimeOptions.SessionID)
	}
}
