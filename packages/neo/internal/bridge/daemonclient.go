package bridge

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// AttachPath records which branch AttachOrSpawn took, for observability and for
// the wave-2 UI to surface ("attached to a running daemon" vs "started one").
type AttachPath int

const (
	// PathHealthyAttach: a live daemon record was found and attached to directly.
	PathHealthyAttach AttachPath = iota
	// PathSpawned: no usable daemon was found (absent/stale/mismatch/corrupt), so
	// a daemon was spawned and then attached to.
	PathSpawned
)

func (p AttachPath) String() string {
	switch p {
	case PathHealthyAttach:
		return "healthy-attach"
	case PathSpawned:
		return "spawned"
	default:
		return fmt.Sprintf("AttachPath(%d)", int(p))
	}
}

// SpawnRequest is what the injected spawner needs to launch the daemon
// supervisor. The production spawner execs `node <cli> --listen <Socket>
// --register` detached (see SpawnDaemonDetached); tests inject a stand-in.
type SpawnRequest struct {
	// Socket is the client-chosen socket path the daemon must bind + register.
	Socket string
	// AgentDir / Cwd identify the daemon's registry slot.
	AgentDir string
	Cwd      string
}

// Spawner launches the daemon supervisor detached. It returns nil once the child
// has been started (not once it has registered — the caller polls the registry).
// A spawn that loses the bind race (EADDRINUSE) still returns nil; the caller
// then finds the winner's record.
type Spawner func(SpawnRequest) error

// AttachConfig configures AttachOrSpawn.
type AttachConfig struct {
	// AgentDir is the resolved senpi agent dir (store.Config.AgentDir()).
	AgentDir string
	// Cwd is the client's working directory. It is used raw for the registry key;
	// callers should pass an already-resolved absolute path (the daemon resolves
	// the same cwd, so the keys match).
	Cwd string
	// Token/Version/Capabilities/RuntimeOptions feed the handshake.
	Capabilities   []string
	RuntimeOptions NeoRuntimeOptions
	// Spawn launches the daemon when no usable record exists. Defaults to
	// SpawnDaemonDetached (production).
	Spawn Spawner
	// Timeout bounds the whole attach-or-spawn (dial + spawn + poll). Default 10s.
	Timeout time.Duration
	// PollInterval is how often the registry is re-read while waiting for a
	// spawned daemon to register. Default 50ms.
	PollInterval time.Duration
}

// DaemonConn is a live attachment to a daemon connection. It owns the Transport
// (an io.ReadWriteCloser carrying the JSONL RPC stream) plus the metadata the UI
// and the recovery loop need.
type DaemonConn struct {
	// Transport is the attached connection; wrap it with NewClient.
	Transport Transport
	// Path records how the attachment was obtained.
	Path AttachPath
	// Record is the registry record that was attached to.
	Record NeoDaemonRecord
	// AgentDir / Cwd identify the daemon slot (used by the recovery loop to
	// re-read the registry and reconnect).
	AgentDir string
	Cwd      string
}

// Close closes the underlying transport. It does NOT shut down the daemon — the
// last client leaving is not the daemon's cue to exit; the daemon's idle timer
// owns its lifecycle (docs/neo.md "Connection lifecycle").
func (c *DaemonConn) Close() error {
	if c.Transport == nil {
		return nil
	}
	return c.Transport.Close()
}

const (
	defaultAttachTimeout = 10 * time.Second
	defaultPollInterval  = 50 * time.Millisecond
)

// ErrAttachTimeout is returned when a spawned daemon does not register + accept a
// handshake within the configured timeout.
var ErrAttachTimeout = errors.New("bridge: attach-or-spawn timed out")

// AttachOrSpawn implements the plan task-17 attach-or-spawn client:
//
//  1. Read the registry for the cwd. If a HEALTHY record exists (live pid,
//     matching version) and its handshake succeeds → attach (PathHealthyAttach).
//  2. Otherwise (absent / stale pid / version mismatch / corrupt / dial-refused)
//     clean up any stale record, spawn the daemon detached on a fresh socket,
//     and poll the registry + handshake until it comes up → attach (PathSpawned).
//
// The spawn-race loser is handled implicitly: its spawned daemon exits on
// EADDRINUSE (returning nil from the spawner), and the poll then observes the
// winner's registry record and attaches to it.
func AttachOrSpawn(cfg AttachConfig) (*DaemonConn, error) {
	if cfg.Spawn == nil {
		cfg.Spawn = SpawnDaemonDetached
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultAttachTimeout
	}
	pollInterval := cfg.PollInterval
	if pollInterval <= 0 {
		pollInterval = defaultPollInterval
	}
	deadline := time.Now().Add(timeout)

	// Step 1: try an existing healthy record.
	if conn, ok := tryAttachExisting(cfg, remaining(deadline)); ok {
		return conn, nil
	}

	// Step 2: no usable daemon — clean any stale record, then spawn + poll.
	cleanupStaleRecord(cfg.AgentDir, cfg.Cwd)

	socket, err := chooseSocketPath(cfg.Cwd)
	if err != nil {
		return nil, fmt.Errorf("bridge: choose socket path: %w", err)
	}
	if err := cfg.Spawn(SpawnRequest{Socket: socket, AgentDir: cfg.AgentDir, Cwd: cfg.Cwd}); err != nil {
		return nil, fmt.Errorf("bridge: spawn daemon: %w", err)
	}

	for time.Now().Before(deadline) {
		if conn, ok := tryAttachExisting(cfg, remaining(deadline)); ok {
			conn.Path = PathSpawned
			return conn, nil
		}
		time.Sleep(pollInterval)
	}
	return nil, fmt.Errorf("%w after %s (cwd %s)", ErrAttachTimeout, timeout, cfg.Cwd)
}

// tryAttachExisting reads the registry and, if the record is healthy (live pid,
// matching version), dials + handshakes. It returns (conn, true) on success. A
// dial failure, refuse, mismatch, or dead pid returns (nil, false) so the caller
// falls through to spawn.
func tryAttachExisting(cfg AttachConfig, budget time.Duration) (*DaemonConn, bool) {
	rec, err := ReadNeoDaemonRecord(cfg.AgentDir, cfg.Cwd)
	if err != nil || rec == nil {
		return nil, false
	}
	if rec.Version != NeoDaemonProtocolVersion {
		return nil, false // version mismatch → respawn
	}
	if !IsPidAlive(rec.PID) {
		return nil, false // stale → respawn
	}
	if budget <= 0 {
		budget = defaultHandshakeTimeout
	}
	tr, herr := DialAndHandshake(DialConfig{
		Socket:         rec.Socket,
		Token:          rec.Token,
		Version:        NeoDaemonProtocolVersion,
		Capabilities:   cfg.Capabilities,
		RuntimeOptions: cfg.RuntimeOptions,
		Timeout:        budget,
	})
	if herr != nil {
		// Dial failure or refuse: the daemon is not usable. Let the caller respawn.
		return nil, false
	}
	return &DaemonConn{
		Transport: tr,
		Path:      PathHealthyAttach,
		Record:    *rec,
		AgentDir:  cfg.AgentDir,
		Cwd:       cfg.Cwd,
	}, true
}

// cleanupStaleRecord removes a stale record (dead pid) and its leftover socket
// file before a fresh spawn, mirroring cleanupStaleNeoDaemon on the daemon side.
// It only removes a record whose pid is dead; a live daemon's record is left
// intact (the race winner may own it).
func cleanupStaleRecord(agentDir, cwd string) {
	rec, err := ReadNeoDaemonRecord(agentDir, cwd)
	path := NeoDaemonRegistryPath(agentDir, cwd)
	if err != nil || rec == nil {
		// Corrupt or absent record: remove any leftover file so the daemon's own
		// pre-bind cleanup starts clean. (A corrupt file is unlinked here so the
		// registry slot is free for the fresh daemon to write.)
		_ = os.Remove(path)
		return
	}
	if IsPidAlive(rec.PID) {
		return
	}
	if rec.Socket != "" {
		_ = os.Remove(rec.Socket)
	}
	_ = os.Remove(path)
}

// chooseSocketPath derives a fresh socket path for a spawned daemon. The unix
// domain socket path must fit sun_path (~104 bytes on macOS, 108 on Linux), and
// the agent dir (which the registry lives under) can be arbitrarily deep, so the
// socket goes in the OS temp dir under a short name instead — the daemon binds
// and registers this exact path, and the registry record carries it so clients
// find it. On Windows it is a named-pipe path in the flat pipe namespace.
func chooseSocketPath(cwd string) (string, error) {
	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", err
	}
	id := hex.EncodeToString(suffix[:])
	if runtime.GOOS == "windows" {
		// Named pipes live in a flat namespace, not the filesystem.
		return `\\.\pipe\senpi-neo-` + neoDaemonCwdShortKey(cwd) + "-" + id, nil
	}
	return filepath.Join(os.TempDir(), "senpi-neo-"+id+".sock"), nil
}

// neoDaemonCwdShortKey is a short, filesystem-safe fragment of the cwd for a
// named-pipe name (Windows pipe names have length limits too). It is not the
// registry key — that stays the full NeoDaemonCwdKey.
func neoDaemonCwdShortKey(cwd string) string {
	sum := hex.EncodeToString([]byte(cwd))
	if len(sum) > 16 {
		return sum[:16]
	}
	return sum
}

// remaining is the time left until deadline (never negative).
func remaining(deadline time.Time) time.Duration {
	d := time.Until(deadline)
	if d < 0 {
		return 0
	}
	return d
}
