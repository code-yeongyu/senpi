package bridge

import (
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// RecoveryStatus is the connection state the wave-2 UI renders.
type RecoveryStatus int

const (
	// RecoveryConnected: attached to a live daemon connection.
	RecoveryConnected RecoveryStatus = iota
	// RecoveryReconnecting: the connection dropped; the loop is reattaching.
	RecoveryReconnecting
	// RecoveryClosed: the session was closed by the caller; no more recovery.
	RecoveryClosed
)

func (s RecoveryStatus) String() string {
	switch s {
	case RecoveryConnected:
		return "connected"
	case RecoveryReconnecting:
		return "reconnecting"
	case RecoveryClosed:
		return "closed"
	default:
		return "unknown"
	}
}

// RecoverySnapshot is an immutable view of the session's recovery state for the
// UI. InFlightTurnAborted is set when a disconnect happened while a turn was in
// flight — the UI renders that turn as aborted with a clear notice.
type RecoverySnapshot struct {
	Status              RecoveryStatus
	InFlightTurnAborted bool
	// LastEntryID is the id the next resume uses as get_entries{since}.
	LastEntryID string
	// ResumedLeafID is the leaf id the last resume reloaded from disk.
	ResumedLeafID string
	// Reconnects counts how many times the loop reattached.
	Reconnects int
}

// SessionConfig configures the recovery loop.
type SessionConfig struct {
	AgentDir      string
	Cwd           string
	Capabilities  []string
	Options       NeoRuntimeOptions
	Spawn         Spawner
	AttachTimeout time.Duration
	BackoffMin    time.Duration
	BackoffMax    time.Duration
}

// Session owns a daemon connection and its recovery lifecycle. On any disconnect
// it ends the in-flight turn, reattaches (reconnect if the daemon is alive,
// respawn if it is dead — AttachOrSpawn handles both), and resumes the SAME
// session file via get_state + get_entries{since:<last entry id>}. It exposes the
// recovery state through Snapshot for the UI.
type Session struct {
	cfg        SessionConfig
	mu         sync.Mutex
	conn       *DaemonConn
	client     *Client
	snap       RecoverySnapshot
	turnLive   bool
	recovered  chan struct{}
	closeCh    chan struct{}
	closeOnce  sync.Once
	backoffMin time.Duration
	backoffMax time.Duration
}

// NewSession wraps an initial attachment and starts the recovery watcher.
func NewSession(conn *DaemonConn, cfg SessionConfig) *Session {
	bmin := cfg.BackoffMin
	if bmin <= 0 {
		bmin = 50 * time.Millisecond
	}
	bmax := cfg.BackoffMax
	if bmax <= 0 {
		bmax = 2 * time.Second
	}
	s := &Session{
		cfg:        cfg,
		conn:       conn,
		client:     NewClient(conn.Transport),
		recovered:  make(chan struct{}, 1),
		closeCh:    make(chan struct{}),
		backoffMin: bmin,
		backoffMax: bmax,
	}
	s.snap.Status = RecoveryConnected
	go s.watch()
	return s
}

// Client returns the currently-live RPC client. It changes after a recovery, so
// callers should fetch it fresh after observing a reconnect.
func (s *Session) Client() *Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client
}

// MarkTurnInFlight records that a turn is running, so a disconnect before it
// completes is surfaced as an aborted turn.
func (s *Session) MarkTurnInFlight() {
	s.mu.Lock()
	s.turnLive = true
	s.mu.Unlock()
}

// MarkTurnComplete clears the in-flight marker (a turn that finished normally is
// not aborted by a later disconnect).
func (s *Session) MarkTurnComplete() {
	s.mu.Lock()
	s.turnLive = false
	s.mu.Unlock()
}

// Snapshot returns the current recovery state.
func (s *Session) Snapshot() RecoverySnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snap
}

// WaitRecovered blocks until the next successful recovery or the timeout.
func (s *Session) WaitRecovered(timeout time.Duration) error {
	select {
	case <-s.recovered:
		return nil
	case <-time.After(timeout):
		return errors.New("bridge: recovery timed out")
	case <-s.closeCh:
		return errors.New("bridge: session closed")
	}
}

// Close stops the recovery loop and closes the current connection. It never
// shuts the daemon down (idle lifecycle owns that).
func (s *Session) Close() error {
	s.closeOnce.Do(func() { close(s.closeCh) })
	s.mu.Lock()
	s.snap.Status = RecoveryClosed
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		return conn.Close()
	}
	return nil
}

// watch waits for the current client to disconnect, then drives recovery until
// the session is closed.
func (s *Session) watch() {
	for {
		s.mu.Lock()
		client := s.client
		s.mu.Unlock()

		select {
		case <-s.closeCh:
			return
		case <-client.Done():
			if s.closed() {
				return
			}
			s.recover()
		}
	}
}

// recover ends the in-flight turn, reattaches (reconnect or respawn), and
// resumes from disk. It retries with backoff until it reconnects or is closed.
func (s *Session) recover() {
	s.mu.Lock()
	aborted := s.turnLive
	s.turnLive = false
	s.snap.Status = RecoveryReconnecting
	if aborted {
		s.snap.InFlightTurnAborted = true
	}
	lastEntry := s.snap.LastEntryID
	s.mu.Unlock()

	backoff := s.backoffMin
	for {
		if s.closed() {
			return
		}
		conn, err := AttachOrSpawn(AttachConfig{
			AgentDir:       s.cfg.AgentDir,
			Cwd:            s.cfg.Cwd,
			Capabilities:   s.cfg.Capabilities,
			RuntimeOptions: s.cfg.Options,
			Spawn:          s.cfg.Spawn,
			Timeout:        s.cfg.AttachTimeout,
		})
		if err == nil {
			s.attachResumed(conn, lastEntry)
			return
		}
		time.Sleep(backoff)
		backoff *= 2
		if backoff > s.backoffMax {
			backoff = s.backoffMax
		}
	}
}

// attachResumed installs the fresh connection, resumes from disk, and publishes
// the reconnected snapshot.
func (s *Session) attachResumed(conn *DaemonConn, lastEntry string) {
	client := NewClient(conn.Transport)
	leafID := resumeFromDisk(client, lastEntry)

	s.mu.Lock()
	s.conn = conn
	s.client = client
	s.snap.Status = RecoveryConnected
	s.snap.Reconnects++
	if leafID != "" {
		s.snap.ResumedLeafID = leafID
		s.snap.LastEntryID = leafID
	}
	s.mu.Unlock()

	select {
	case s.recovered <- struct{}{}:
	default:
	}
}

func (s *Session) closed() bool {
	select {
	case <-s.closeCh:
		return true
	default:
		return false
	}
}

// resumeFromDisk performs the plan resume: get_state to confirm the session, then
// get_entries{since:<lastEntry>} for an efficient reload. It returns the leaf id
// from get_entries (the id the next resume uses as `since`).
func resumeFromDisk(client *Client, lastEntry string) string {
	if _, err := client.Request(Command{Type: "get_state"}, DefaultRequestTimeout); err != nil {
		return ""
	}
	fields := map[string]any{}
	if lastEntry != "" {
		fields["since"] = lastEntry
	}
	resp, err := client.Request(Command{Type: "get_entries", Fields: fields}, DefaultRequestTimeout)
	if err != nil || !resp.Success {
		return ""
	}
	var data struct {
		LeafID string `json:"leafId"`
	}
	if json.Unmarshal(resp.Data, &data) != nil {
		return ""
	}
	return data.LeafID
}
