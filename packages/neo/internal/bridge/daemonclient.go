package bridge

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
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
	// AgentDirEnvName is the env var the daemon reads to resolve its agent dir
	// (store.Config.AgentDirEnvName(), e.g. "SENPI_CODING_AGENT_DIR"). The spawner
	// sets it to AgentDir in the daemon's env so the daemon registers into EXACTLY
	// the dir the client polls — never relying on ambient inheritance, which can
	// silently diverge (daemon registers to ~/.senpi while the client polls a
	// sandbox, or vice versa). Empty leaves the env untouched.
	AgentDirEnvName string
	// SessionDirEnvName / SessionDir similarly pin the daemon's session dir so its
	// workers resume sessions from the same place the client used. Empty skips it.
	SessionDirEnvName string
	SessionDir        string
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
	// AgentDirEnvName / SessionDirEnvName + SessionDir pin the spawned daemon's
	// dirs explicitly (see SpawnRequest) so it registers where the client polls.
	AgentDirEnvName   string
	SessionDirEnvName string
	SessionDir        string
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
	// defaultAttachTimeout gives a freshly-spawned daemon time to bind + register
	// + accept the first handshake. A compiled dist daemon does this in well under
	// a second; a dev daemon running the CLI from uncompiled TypeScript loads its
	// full runtime and, under machine load, can take several seconds — so the
	// default is generous (a fast daemon still attaches on the first poll, paying
	// no penalty). Override with EnvNeoAttachTimeoutMS for slower/faster hosts.
	defaultAttachTimeout = 30 * time.Second
	defaultPollInterval  = 50 * time.Millisecond
)

// EnvNeoAttachTimeoutMS overrides defaultAttachTimeout (milliseconds) for the
// daemon attach-or-spawn deadline. Unset/invalid falls back to the default.
const EnvNeoAttachTimeoutMS = "SENPI_NEO_ATTACH_TIMEOUT_MS"

// ErrAttachTimeout is returned when a spawned daemon does not register + accept a
// handshake within the configured timeout.
var ErrAttachTimeout = errors.New("bridge: attach-or-spawn timed out")

// attachTimeoutDefault resolves the default attach timeout, honoring
// EnvNeoAttachTimeoutMS when it parses to a positive duration.
func attachTimeoutDefault() time.Duration {
	if v := strings.TrimSpace(os.Getenv(EnvNeoAttachTimeoutMS)); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return defaultAttachTimeout
}

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
		timeout = attachTimeoutDefault()
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
	if err := cfg.Spawn(SpawnRequest{
		Socket:            socket,
		AgentDir:          cfg.AgentDir,
		Cwd:               cfg.Cwd,
		AgentDirEnvName:   cfg.AgentDirEnvName,
		SessionDirEnvName: cfg.SessionDirEnvName,
		SessionDir:        cfg.SessionDir,
	}); err != nil {
		return nil, fmt.Errorf("bridge: spawn daemon: %w", err)
	}

	for time.Now().Before(deadline) {
		if conn, ok := tryAttachExisting(cfg, remaining(deadline)); ok {
			conn.Path = PathSpawned
			return conn, nil
		}
		// Recover the "live daemon owns the deterministic socket, but the registry
		// record for this cwd is lost/corrupt" wedge: the spawn we just fired lost
		// the bind race to the live daemon (EADDRINUSE) and never registered, so
		// polling an empty registry alone would hang until the timeout. When the
		// deterministic socket is LIVE, poke it — the daemon re-asserts its own
		// registry record on accept (self-heal, neo-daemon-mode.ts), so the next
		// poll finds the healed record (carrying the daemon's real token) and
		// attaches. A dead/absent socket is a no-op; the spawned daemon is still
		// coming up and the ordinary poll handles it.
		pokeDeterministicSocketIfLive(socket)
		time.Sleep(pollInterval)
	}
	return nil, fmt.Errorf("%w after %s (cwd %s)", ErrAttachTimeout, timeout, cfg.Cwd)
}

// pokeDeterministicSocketIfLive opens (and immediately closes) a connection to the
// deterministic socket to trigger a live daemon's on-accept registry self-heal.
// It is a bounded, best-effort probe: a dead/absent socket errors out fast and is
// ignored, so a spawned-but-not-yet-listening daemon (the ordinary spawn path) is
// unaffected. It never sends a hello, so it cannot spawn a worker or alter daemon
// state beyond the record re-assertion the accept itself drives.
func pokeDeterministicSocketIfLive(socket string) {
	conn, err := dialNeoSocket(socket, socketProbeTimeout)
	if err != nil {
		return
	}
	_ = conn.Close()
}

const socketProbeTimeout = 250 * time.Millisecond

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

// chooseSocketPath derives the socket path for a spawned daemon DETERMINISTICALLY
// from the resolved cwd. This is load-bearing for the spawn race: the plan's
// "bind is the mutex" protocol only engages if every concurrent racer in one cwd
// targets the SAME --listen path, so exactly one daemon wins bind() and the rest
// get EADDRINUSE and attach to the winner (neo-daemon-mode.ts). A random per-
// client path would let every racer bind its own socket, leaving N daemons.
//
// The name is a fixed-length hash of the same resolved-cwd string the registry
// key uses (NeoDaemonCwdKey), so it is identical across processes, collision-
// resistant, and short. The unix domain socket path must fit sun_path (~104
// bytes on macOS, 108 on Linux) and the agent dir can be arbitrarily deep, so
// the socket goes in the OS temp dir under this short hashed name instead — the
// daemon binds and registers this exact path, and the registry record carries it
// so clients find it. On Windows it is a named-pipe path in the flat namespace.
func chooseSocketPath(cwd string) (string, error) {
	h := neoDaemonCwdSocketHash(cwd)
	if runtime.GOOS == "windows" {
		// Named pipes live in a flat namespace, not the filesystem.
		return `\\.\pipe\senpi-neo-` + h, nil
	}
	return filepath.Join(os.TempDir(), "senpi-neo-"+h+".sock"), nil
}

// neoDaemonCwdSocketHash is the first 16 hex chars (8 bytes / 64 bits) of the
// SHA-256 of the resolved cwd — enough entropy to be collision-resistant across
// the cwds one machine hosts while keeping the socket path well under sun_path.
func neoDaemonCwdSocketHash(cwd string) string {
	sum := sha256.Sum256([]byte(cwd))
	return hex.EncodeToString(sum[:])[:16]
}

// remaining is the time left until deadline (never negative).
func remaining(deadline time.Time) time.Duration {
	d := time.Until(deadline)
	if d < 0 {
		return 0
	}
	return d
}
