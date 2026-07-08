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

// --- Race: N clients spawn simultaneously → exactly one daemon ----------------

// bindMutexSpawner models the REAL "bind is the mutex" daemon protocol
// (neo-daemon-mode.ts: bind FIRST, register as the LAST listen step, a bind
// loser gets EADDRINUSE and never registers). It arbitrates purely on the
// socket path each spawn requests — exactly as the OS unix-domain bind() does:
//
//   - the FIRST spawn to target a given path "wins": it binds a real listener on
//     that path and writes the registry record;
//   - any later spawn targeting the SAME path loses (EADDRINUSE) and does NOT
//     register — matching the launcher exiting NEO_DAEMON_ADDRESS_IN_USE_EXIT;
//   - a spawn targeting a DIFFERENT path would wrongly win and register there,
//     which is precisely the divergence the random-path bug produced.
//
// Because arbitration is by path, this fake CANNOT converge unless the client
// makes all racers compute the SAME deterministic path. It records every path it
// saw so the test can assert determinism directly.
type bindMutexSpawner struct {
	t        *testing.T
	agentDir string
	cwd      string
	token    string
	mu       sync.Mutex
	bound    map[string]*scriptedDaemon // socket path -> winning daemon
	paths    []string                   // every path any racer requested
}

func newBindMutexSpawner(t *testing.T, agentDir, cwd, token string) *bindMutexSpawner {
	return &bindMutexSpawner{t: t, agentDir: agentDir, cwd: cwd, token: token, bound: map[string]*scriptedDaemon{}}
}

func (s *bindMutexSpawner) spawn(req SpawnRequest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.paths = append(s.paths, req.Socket)
	if _, taken := s.bound[req.Socket]; taken {
		// Bind loser: EADDRINUSE. The launcher exits 75 without registering; the
		// spawner still returns nil and the client re-reads the winner's record.
		return nil
	}
	// The real daemon reclaims a dead leftover socket file before bind (see
	// reclaimDeadSocketFile). Model that so a socket file orphaned by an earlier
	// run does not wedge the winner's listen.
	_ = os.Remove(req.Socket)
	// Bind winner: bind a real listener on the requested path and register LAST.
	ln, err := net.Listen("unix", req.Socket)
	if err != nil {
		return fmt.Errorf("bind winner listen %q: %w", req.Socket, err)
	}
	s.t.Cleanup(func() { _ = os.Remove(req.Socket) })
	d := &scriptedDaemon{
		agentDir: s.agentDir, cwd: s.cwd, socket: req.Socket, token: s.token, version: NeoDaemonProtocolVersion,
		ln: ln, hellos: make(chan NeoHelloMessage, 8),
	}
	go d.serve(ln)
	s.t.Cleanup(d.stop)
	d.register(s.t, os.Getpid())
	s.bound[req.Socket] = d
	return nil
}

func (s *bindMutexSpawner) distinctPaths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[string]struct{}{}
	var out []string
	for _, p := range s.paths {
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out
}

func (s *bindMutexSpawner) liveDaemonCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.bound)
}

func TestAttachOrSpawn_RaceExactlyOneDaemon(t *testing.T) {
	agentDir := t.TempDir()
	// The socket path is derived from the cwd, so use a per-run unique cwd to keep
	// concurrent test runs from colliding on the same deterministic socket file.
	cwd := t.TempDir()

	sp := newBindMutexSpawner(t, agentDir, cwd, "tok-race")

	const clients = 4
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
				Spawn:    sp.spawn,
				Timeout:  4 * time.Second,
			})
			results[idx], errs[idx] = res, err
		}(i)
	}
	wg.Wait()

	// Every racer must have computed the SAME deterministic socket path — this is
	// the invariant that lets the bind() actually arbitrate the race. With the old
	// random-path code this fails here (N distinct paths).
	if paths := sp.distinctPaths(); len(paths) != 1 {
		t.Fatalf("racers diverged on socket path: %d distinct paths %v (want 1)", len(paths), paths)
	}

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

	// Exactly one daemon won the bind, so exactly one live daemon exists.
	if live := sp.liveDaemonCount(); live != 1 {
		t.Fatalf("expected exactly 1 live daemon after race, got %d", live)
	}

	// Exactly one registry record, pointing at this process (the winner).
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

func TestAttachTimeoutDefaultHonorsEnv(t *testing.T) {
	t.Setenv(EnvNeoAttachTimeoutMS, "1234")
	if got := attachTimeoutDefault(); got != 1234*time.Millisecond {
		t.Fatalf("env override: got %v want 1.234s", got)
	}
	t.Setenv(EnvNeoAttachTimeoutMS, "garbage")
	if got := attachTimeoutDefault(); got != defaultAttachTimeout {
		t.Fatalf("invalid env must fall back to default, got %v", got)
	}
	t.Setenv(EnvNeoAttachTimeoutMS, "")
	if got := attachTimeoutDefault(); got != defaultAttachTimeout {
		t.Fatalf("unset env must use default, got %v", got)
	}
}
