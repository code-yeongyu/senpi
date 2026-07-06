package bridge

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// selfHealDaemon is a scripted stand-in for the REAL task-15 daemon's self-heal
// behavior (neo-daemon-mode.ts): it binds the client's deterministic socket path,
// serves the handshake, and — crucially — RE-ASSERTS its own registry record when
// it accepts a connection whenever that record is missing or does not match its
// own pid/socket/token. This models the production daemon's on-accept self-heal so
// the bridge-level test can prove the CLIENT recovers from a lost record while the
// daemon is alive, rather than wedging to the attach timeout.
//
// It writes the token IT holds in memory (never derivable by the client from the
// socket path alone), so the healed record is what re-establishes token auth.
type selfHealDaemon struct {
	agentDir  string
	cwd       string
	socket    string
	token     string
	version   int
	mu        sync.Mutex
	ln        net.Listener
	accepts   atomic.Int64
	healOnAcc bool // when true, re-assert the record on each accepted connection
}

func newSelfHealDaemon(t *testing.T, agentDir, cwd, socket, token string, healOnAccept bool) *selfHealDaemon {
	t.Helper()
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("self-heal daemon listen %q: %v", socket, err)
	}
	d := &selfHealDaemon{
		agentDir: agentDir, cwd: cwd, socket: socket, token: token,
		version: NeoDaemonProtocolVersion, ln: ln, healOnAcc: healOnAccept,
	}
	go d.serve(ln)
	t.Cleanup(d.stop)
	return d
}

func (d *selfHealDaemon) serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		d.accepts.Add(1)
		if d.healOnAcc {
			d.reassertRecord()
		}
		go d.handle(conn)
	}
}

// reassertRecord writes the daemon's own record iff it is missing or does not
// match this daemon (pid/socket/token). It never clobbers an already-correct
// record. Mirrors the production self-heal invariant.
func (d *selfHealDaemon) reassertRecord() {
	rec, _ := ReadNeoDaemonRecord(d.agentDir, d.cwd)
	if rec != nil && rec.PID == os.Getpid() && rec.Socket == d.socket && rec.Token == d.token && rec.Version == d.version {
		return // already correct — do not fight a valid record
	}
	writeSelfHealRecord(d)
}

func writeSelfHealRecord(d *selfHealDaemon) {
	rec := NeoDaemonRecord{Version: d.version, Socket: d.socket, PID: os.Getpid(), Token: d.token}
	path := NeoDaemonRegistryPath(d.agentDir, d.cwd)
	_ = os.MkdirAll(neoDaemonRegistryDirForTest(path), 0o755)
	b, _ := json.MarshalIndent(rec, "", "  ")
	tmp := fmt.Sprintf("%s.%d.%d.tmp", path, os.Getpid(), time.Now().UnixNano())
	_ = os.WriteFile(tmp, b, 0o600)
	_ = os.Rename(tmp, path)
}

func neoDaemonRegistryDirForTest(recordPath string) string {
	// recordPath is <dir>/<key>.json; the dir is its parent.
	for i := len(recordPath) - 1; i >= 0; i-- {
		if recordPath[i] == '/' || recordPath[i] == '\\' {
			return recordPath[:i]
		}
	}
	return "."
}

func (d *selfHealDaemon) handle(conn net.Conn) {
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
	time.Sleep(300 * time.Millisecond)
}

func (d *selfHealDaemon) stop() {
	d.mu.Lock()
	ln := d.ln
	d.ln = nil
	d.mu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
}

// TestAttachOrSpawn_LiveDaemonLostRecordRecovers is the RED reproduction of the
// wave-3 chaos MAJOR: a LIVE daemon holds the deterministic socket for a cwd, but
// that cwd's registry record is then LOST (corrupted / removed / SIGKILL without a
// clean shutdown). A fresh client must recover to a working attached connection
// FAST, not wedge to the attach timeout.
//
// Before the client fix: AttachOrSpawn reads the empty registry, spawns a daemon
// (which loses the bind race to the live one and never registers), and then polls
// an empty registry until timeout — a 30 s wedge, and the live daemon leaks.
//
// After the fix: the client, seeing the deterministic socket is LIVE but the
// registry empty, probe-connects the socket (triggering the daemon's on-accept
// self-heal), then polls until the re-asserted record lands and attaches with the
// healed token.
func TestAttachOrSpawn_LiveDaemonLostRecordRecovers(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir() // per-run unique cwd → unique deterministic socket

	socket, err := chooseSocketPath(cwd)
	if err != nil {
		t.Fatalf("chooseSocketPath: %v", err)
	}

	// A live daemon on the deterministic socket that self-heals its record on
	// accept (models the real daemon). Its record is then DELETED to reproduce the
	// lost-record state while the daemon stays alive.
	d := newSelfHealDaemon(t, agentDir, cwd, socket, "tok-live-heal", true)
	writeSelfHealRecord(d) // initial register (as the real daemon does on listen)
	// Lose the record: SIGKILL-without-clean-shutdown / corruption / removal.
	if err := os.Remove(NeoDaemonRegistryPath(agentDir, cwd)); err != nil {
		t.Fatalf("remove record to model loss: %v", err)
	}
	if rec, _ := ReadNeoDaemonRecord(agentDir, cwd); rec != nil {
		t.Fatalf("precondition: record should be gone, got %+v", rec)
	}

	// The spawner must NOT be able to produce a working daemon here (the live one
	// owns the socket). Model the real bind-mutex loser: a spawn attempt returns nil
	// but never registers, exactly as NEO_DAEMON_ADDRESS_IN_USE_EXIT does. If the
	// client relied ONLY on this spawn to recover, it would wedge — which is the
	// bug. Recovery must come from the self-heal, not the spawn.
	var spawnCalls atomic.Int64
	spawn := func(SpawnRequest) error {
		spawnCalls.Add(1)
		return nil // bind loser: no registration
	}

	start := time.Now()
	conn, aerr := AttachOrSpawn(AttachConfig{
		AgentDir: agentDir,
		Cwd:      cwd,
		Spawn:    spawn,
		Timeout:  6 * time.Second,
	})
	elapsed := time.Since(start)
	if aerr != nil {
		t.Fatalf("AttachOrSpawn wedged/failed on lost-record-while-alive: %v (elapsed %s, accepts=%d)", aerr, elapsed, d.accepts.Load())
	}
	t.Cleanup(func() { _ = conn.Close() })

	// Recovery must be FAST (well under a second), not at the timeout edge.
	if elapsed > 2*time.Second {
		t.Fatalf("recovery too slow: %s (should self-heal fast, not wedge to timeout)", elapsed)
	}

	// The healed record must point at the live daemon and carry its real token.
	rec, rerr := ReadNeoDaemonRecord(agentDir, cwd)
	if rerr != nil || rec == nil {
		t.Fatalf("registry not self-healed: rec=%v err=%v", rec, rerr)
	}
	if rec.Socket != socket {
		t.Fatalf("healed record socket %q != live daemon socket %q", rec.Socket, socket)
	}
	if rec.Token != "tok-live-heal" {
		t.Fatalf("healed record token %q != live daemon token (auth preserved)", rec.Token)
	}
	if conn.Record.Socket != socket {
		t.Fatalf("client attached to %q, not the live daemon %q", conn.Record.Socket, socket)
	}
}
