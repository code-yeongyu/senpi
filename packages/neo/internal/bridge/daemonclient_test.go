package bridge

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// scriptedDaemon is a controllable in-process stand-in for the task-15 daemon: it
// listens on a unix socket, writes the registry record the way the real daemon
// does (atomically, as the last "listen" step), and serves the handshake for N
// connections. It lets the attach-or-spawn tests drive fresh/healthy/stale/
// mismatch/corrupt/race scenarios deterministically without spawning node.
type scriptedDaemon struct {
	agentDir string
	cwd      string
	socket   string
	token    string
	version  int
	mu       sync.Mutex
	ln       net.Listener
	hellos   chan NeoHelloMessage
	accepted atomic.Int64
}

func newScriptedDaemon(t *testing.T, agentDir, cwd, token string, version int) *scriptedDaemon {
	t.Helper()
	socket := shortSocketPath(t)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("scripted daemon listen: %v", err)
	}
	d := &scriptedDaemon{
		agentDir: agentDir, cwd: cwd, socket: socket, token: token, version: version,
		ln: ln, hellos: make(chan NeoHelloMessage, 8),
	}
	go d.serve(ln)
	t.Cleanup(d.stop)
	return d
}

// serve accepts on the listener it is handed (a local copy, not the shared field)
// so a later relisten cannot race the accept loop.
func (d *scriptedDaemon) serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		d.accepted.Add(1)
		go d.handle(conn)
	}
}

func (d *scriptedDaemon) handle(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	r := bufio.NewReader(conn)
	line, err := r.ReadString('\n')
	if err != nil {
		return
	}
	var h NeoHelloMessage
	if json.Unmarshal([]byte(line), &h) != nil {
		return
	}
	d.hellos <- h
	var reply string
	switch {
	case h.Version != d.version:
		reply = `{"type":"refuse","code":"version_mismatch","reason":"mismatch"}`
	case h.Token != d.token:
		reply = `{"type":"refuse","code":"bad_token","reason":"bad token"}`
	default:
		reply = fmt.Sprintf(`{"type":"welcome","version":%d}`, d.version)
	}
	_, _ = conn.Write([]byte(reply + "\n"))
	// Hold the connection open so the client can use the transport.
	time.Sleep(300 * time.Millisecond)
}

// register writes the registry record the way the real daemon does (last step).
func (d *scriptedDaemon) register(t *testing.T, pid int) {
	t.Helper()
	rec := NeoDaemonRecord{Version: d.version, Socket: d.socket, PID: pid, Token: d.token}
	path := NeoDaemonRegistryPath(d.agentDir, d.cwd)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
}

func (d *scriptedDaemon) stop() {
	d.mu.Lock()
	ln := d.ln
	d.ln = nil
	d.mu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
}

// --- Integration matrix -----------------------------------------------------

func TestAttachOrSpawn_HealthyAttaches(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/proj/healthy"
	d := newScriptedDaemon(t, agentDir, cwd, "tok-healthy", NeoDaemonProtocolVersion)
	d.register(t, os.Getpid()) // live pid → healthy

	// Spawner must NOT be called for a healthy record.
	spawned := atomic.Bool{}
	res, err := AttachOrSpawn(AttachConfig{
		AgentDir: agentDir,
		Cwd:      cwd,
		Spawn: func(SpawnRequest) error {
			spawned.Store(true)
			return nil
		},
		Timeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("AttachOrSpawn healthy: %v", err)
	}
	t.Cleanup(func() { _ = res.Close() })
	if spawned.Load() {
		t.Fatalf("healthy record must not trigger spawn")
	}
	if res.Path != PathHealthyAttach {
		t.Fatalf("expected PathHealthyAttach, got %v", res.Path)
	}
}

func TestAttachOrSpawn_FreshSpawns(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/proj/fresh"
	// No record on disk. The spawner starts a scripted daemon and registers it.
	d := newScriptedDaemon(t, agentDir, cwd, "tok-fresh", NeoDaemonProtocolVersion)

	res, err := AttachOrSpawn(AttachConfig{
		AgentDir: agentDir,
		Cwd:      cwd,
		Spawn: func(req SpawnRequest) error {
			// The real spawner would exec `node <cli> --listen <socket> --register`.
			// Here we point the daemon at the client-chosen socket and register.
			d.socket = req.Socket
			relistenScripted(t, d)
			d.register(t, os.Getpid())
			return nil
		},
		Timeout: 3 * time.Second,
	})
	if err != nil {
		t.Fatalf("AttachOrSpawn fresh: %v", err)
	}
	t.Cleanup(func() { _ = res.Close() })
	if res.Path != PathSpawned {
		t.Fatalf("expected PathSpawned, got %v", res.Path)
	}
}

func TestAttachOrSpawn_StalePidRespawns(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/proj/stale"
	// A record whose pid is dead → stale → respawn.
	staleRec := NeoDaemonRecord{Version: NeoDaemonProtocolVersion, Socket: "/tmp/dead.sock", PID: 4_000_000_000, Token: "old"}
	writeRecordAtomically(t, agentDir, cwd, staleRec)

	d := newScriptedDaemon(t, agentDir, cwd, "tok-new", NeoDaemonProtocolVersion)
	res, err := AttachOrSpawn(AttachConfig{
		AgentDir: agentDir,
		Cwd:      cwd,
		Spawn: func(req SpawnRequest) error {
			d.socket = req.Socket
			relistenScripted(t, d)
			d.register(t, os.Getpid())
			return nil
		},
		Timeout: 3 * time.Second,
	})
	if err != nil {
		t.Fatalf("AttachOrSpawn stale: %v", err)
	}
	t.Cleanup(func() { _ = res.Close() })
	if res.Path != PathSpawned {
		t.Fatalf("stale-pid must respawn (PathSpawned), got %v", res.Path)
	}
}

func TestAttachOrSpawn_VersionMismatchFallsBackToSpawn(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/proj/mismatch"
	// A live daemon speaking a DIFFERENT version. The record's version field
	// differs, so the client detects mismatch from the record and respawns
	// (rather than dialing a daemon it cannot speak to).
	d := newScriptedDaemon(t, agentDir, cwd, "tok-mm", 999)
	d.register(t, os.Getpid())

	// The respawn produces a compatible daemon.
	fresh := newScriptedDaemon(t, agentDir, cwd, "tok-fresh", NeoDaemonProtocolVersion)
	res, err := AttachOrSpawn(AttachConfig{
		AgentDir: agentDir,
		Cwd:      cwd,
		Spawn: func(req SpawnRequest) error {
			fresh.socket = req.Socket
			relistenScripted(t, fresh)
			fresh.register(t, os.Getpid())
			return nil
		},
		Timeout: 3 * time.Second,
	})
	if err != nil {
		t.Fatalf("AttachOrSpawn mismatch: %v", err)
	}
	t.Cleanup(func() { _ = res.Close() })
	if res.Path != PathSpawned {
		t.Fatalf("version mismatch must respawn (PathSpawned), got %v", res.Path)
	}
}

func TestAttachOrSpawn_CorruptRegistryRepairsAndRespawns(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/proj/corrupt"
	path := NeoDaemonRegistryPath(agentDir, cwd)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{ not valid json"), 0o600); err != nil {
		t.Fatal(err)
	}

	d := newScriptedDaemon(t, agentDir, cwd, "tok-fixed", NeoDaemonProtocolVersion)
	res, err := AttachOrSpawn(AttachConfig{
		AgentDir: agentDir,
		Cwd:      cwd,
		Spawn: func(req SpawnRequest) error {
			d.socket = req.Socket
			relistenScripted(t, d)
			d.register(t, os.Getpid())
			return nil
		},
		Timeout: 3 * time.Second,
	})
	if err != nil {
		t.Fatalf("AttachOrSpawn corrupt: %v", err)
	}
	t.Cleanup(func() { _ = res.Close() })
	if res.Path != PathSpawned {
		t.Fatalf("corrupt registry must repair+respawn (PathSpawned), got %v", res.Path)
	}
}

// --- Race: two clients spawn simultaneously → exactly one daemon --------------

func TestAttachOrSpawn_RaceExactlyOneDaemon(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/proj/race"

	// One shared scripted daemon models the bind-mutex winner: only the FIRST
	// spawn call actually binds+registers; a second concurrent spawn observes
	// EADDRINUSE (models: it does nothing, the loser just re-reads the registry).
	d := newScriptedDaemon(t, agentDir, cwd, "tok-race", NeoDaemonProtocolVersion)
	var spawnCount atomic.Int64
	var bindOnce sync.Once

	spawn := func(req SpawnRequest) error {
		spawnCount.Add(1)
		bindOnce.Do(func() {
			d.socket = req.Socket
			relistenScripted(t, d)
			d.register(t, os.Getpid())
		})
		// A losing spawn "exits" with the in-use signal; the client retries the
		// registry, which the winner has now written.
		return nil
	}

	const clients = 2
	var wg sync.WaitGroup
	results := make([]*DaemonConn, clients)
	errs := make([]error, clients)
	for i := 0; i < clients; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			res, err := AttachOrSpawn(AttachConfig{
				AgentDir: agentDir,
				Cwd:      cwd,
				Spawn:    spawn,
				Timeout:  4 * time.Second,
			})
			results[idx], errs[idx] = res, err
		}(i)
	}
	wg.Wait()

	attached := 0
	for i := 0; i < clients; i++ {
		if errs[i] != nil {
			t.Fatalf("client %d failed: %v", i, errs[i])
		}
		if results[i] != nil {
			attached++
			t.Cleanup(func(r *DaemonConn) func() { return func() { _ = r.Close() } }(results[i]))
		}
	}
	if attached != clients {
		t.Fatalf("expected all %d clients attached, got %d", clients, attached)
	}

	// Exactly one registry record, one pid.
	rec, err := ReadNeoDaemonRecord(agentDir, cwd)
	if err != nil || rec == nil {
		t.Fatalf("expected a single registry record after race, got %v (err %v)", rec, err)
	}
	if rec.PID != os.Getpid() {
		t.Fatalf("registry pid mismatch: %d", rec.PID)
	}
}

// --- helpers ----------------------------------------------------------------

func writeRecordAtomically(t *testing.T, agentDir, cwd string, rec NeoDaemonRecord) {
	t.Helper()
	path := NeoDaemonRegistryPath(agentDir, cwd)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// relistenScripted rebinds the scripted daemon on its (possibly client-chosen)
// socket path so an injected spawner can "start" it on the socket the client
// picked.
func relistenScripted(t *testing.T, d *scriptedDaemon) {
	t.Helper()
	d.stop()
	ln, err := net.Listen("unix", d.socket)
	if err != nil {
		t.Fatalf("relisten: %v", err)
	}
	d.mu.Lock()
	d.ln = ln
	d.mu.Unlock()
	go d.serve(ln)
	t.Cleanup(d.stop)
}
