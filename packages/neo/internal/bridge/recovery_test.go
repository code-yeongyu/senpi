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

// resumingDaemon is a scripted daemon that also answers get_state and
// get_entries so the recovery loop's resume path can be exercised. It records the
// `since` value each get_entries carried, and can be told to drop the current
// connection to simulate a socket disconnect with the daemon still alive.
type resumingDaemon struct {
	agentDir string
	cwd      string
	socket   string
	token    string
	ln       net.Listener
	mu       sync.Mutex
	conns    []net.Conn
	sinceLog []string
	leafID   string
	accepts  atomic.Int64
	stopped  atomic.Bool
}

func newResumingDaemon(t *testing.T, agentDir, cwd, token, leafID string) *resumingDaemon {
	t.Helper()
	socket := shortSocketPath(t)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("resuming daemon listen: %v", err)
	}
	d := &resumingDaemon{agentDir: agentDir, cwd: cwd, socket: socket, token: token, ln: ln, leafID: leafID}
	go d.serve(ln)
	t.Cleanup(d.stop)
	return d
}

// serve accepts on the listener it is handed (a local copy) so a respawn's
// relisten cannot race the accept loop.
func (d *resumingDaemon) serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		d.accepts.Add(1)
		d.mu.Lock()
		d.conns = append(d.conns, conn)
		d.mu.Unlock()
		go d.handle(conn)
	}
}

func (d *resumingDaemon) handle(conn net.Conn) {
	r := bufio.NewReader(conn)
	// Handshake.
	line, err := r.ReadString('\n')
	if err != nil {
		return
	}
	var h NeoHelloMessage
	if json.Unmarshal([]byte(line), &h) != nil || h.Token != d.token {
		_, _ = conn.Write([]byte(`{"type":"refuse","code":"bad_token","reason":"bad"}` + "\n"))
		_ = conn.Close()
		return
	}
	_, _ = conn.Write([]byte(`{"type":"welcome","version":1}` + "\n"))

	// Serve RPC.
	for {
		cmdLine, rerr := r.ReadString('\n')
		if rerr != nil {
			return
		}
		var cmd struct {
			ID    string `json:"id"`
			Type  string `json:"type"`
			Since string `json:"since"`
		}
		if json.Unmarshal([]byte(cmdLine), &cmd) != nil {
			continue
		}
		switch cmd.Type {
		case "get_state":
			resp := fmt.Sprintf(`{"id":%q,"type":"response","command":"get_state","success":true,"data":{"sessionId":"sess-1","thinkingLevel":"medium","isStreaming":false,"isCompacting":false,"steeringMode":"all","followUpMode":"all","autoCompactionEnabled":true,"messageCount":2,"pendingMessageCount":0}}`, cmd.ID)
			_, _ = conn.Write([]byte(resp + "\n"))
		case "get_entries":
			d.mu.Lock()
			d.sinceLog = append(d.sinceLog, cmd.Since)
			d.mu.Unlock()
			resp := fmt.Sprintf(`{"id":%q,"type":"response","command":"get_entries","success":true,"data":{"entries":[{"id":"e2","type":"message"}],"leafId":%q}}`, cmd.ID, d.leafID)
			_, _ = conn.Write([]byte(resp + "\n"))
		default:
			resp := fmt.Sprintf(`{"id":%q,"type":"response","command":%q,"success":true}`, cmd.ID, cmd.Type)
			_, _ = conn.Write([]byte(resp + "\n"))
		}
	}
}

// dropConnections closes every live connection, simulating a socket disconnect
// with the daemon still alive and listening.
func (d *resumingDaemon) dropConnections() {
	d.mu.Lock()
	conns := d.conns
	d.conns = nil
	d.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

func (d *resumingDaemon) register(t *testing.T, pid int) {
	t.Helper()
	writeRecordAtomically(t, d.agentDir, d.cwd, NeoDaemonRecord{
		Version: NeoDaemonProtocolVersion, Socket: d.socket, PID: pid, Token: d.token,
	})
}

func (d *resumingDaemon) stop() {
	if d.stopped.Swap(true) {
		return
	}
	d.mu.Lock()
	ln := d.ln
	d.mu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
}

func (d *resumingDaemon) sinceValues() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := append([]string(nil), d.sinceLog...)
	return out
}

// --- drop-only recovery (daemon alive) --------------------------------------

func TestRecovery_DropReconnectsAndResumes(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/proj/drop"
	d := newResumingDaemon(t, agentDir, cwd, "tok-drop", "e2")
	d.register(t, os.Getpid())

	conn, err := AttachOrSpawn(AttachConfig{AgentDir: agentDir, Cwd: cwd, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("initial attach: %v", err)
	}

	sess := NewSession(conn, SessionConfig{
		AgentDir: agentDir, Cwd: cwd,
		BackoffMin: 5 * time.Millisecond, BackoffMax: 50 * time.Millisecond,
		AttachTimeout: 2 * time.Second,
	})
	t.Cleanup(func() { _ = sess.Close() })

	// A turn is in flight when the drop happens.
	sess.MarkTurnInFlight()

	// Drop the connection (daemon stays alive).
	d.dropConnections()

	// The session must recover: reconnect, mark the in-flight turn aborted, and
	// resume from the last persisted entry id.
	if err := sess.WaitRecovered(3 * time.Second); err != nil {
		t.Fatalf("did not recover after drop: %v; snapshot=%+v", err, sess.Snapshot())
	}

	snap := sess.Snapshot()
	if !snap.InFlightTurnAborted {
		t.Fatalf("in-flight turn must be shown aborted after a drop: %+v", snap)
	}
	if snap.Status != RecoveryConnected {
		t.Fatalf("expected reconnected status, got %v", snap.Status)
	}
	if snap.ResumedLeafID != "e2" {
		t.Fatalf("resume must reload leaf id from disk, got %q", snap.ResumedLeafID)
	}
	// The resume must have asked get_entries with a `since` (efficient reload).
	if len(d.sinceValues()) == 0 {
		t.Fatalf("resume must issue get_entries{since}")
	}
}

// --- SIGKILL recovery (daemon dead → respawn) -------------------------------

func TestRecovery_DaemonDeadRespawnsAndResumes(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/proj/kill"
	// First daemon is alive, then "killed": we stop its listener AND write a
	// record with a dead pid so the recovery loop respawns rather than reconnects.
	d1 := newResumingDaemon(t, agentDir, cwd, "tok-1", "e2")
	d1.register(t, os.Getpid())

	conn, err := AttachOrSpawn(AttachConfig{AgentDir: agentDir, Cwd: cwd, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("initial attach: %v", err)
	}

	// The respawn produces a fresh daemon.
	d2 := newResumingDaemon(t, agentDir, cwd, "tok-2", "e2")
	d2.stop() // not yet listening on its own socket; the spawner relistens it

	sess := NewSession(conn, SessionConfig{
		AgentDir: agentDir, Cwd: cwd,
		BackoffMin: 5 * time.Millisecond, BackoffMax: 50 * time.Millisecond,
		AttachTimeout: 3 * time.Second,
		Spawn: func(req SpawnRequest) error {
			// Model a respawn: bind d2 on the client-chosen socket and register it.
			d2.socket = req.Socket
			ln, lerr := net.Listen("unix", d2.socket)
			if lerr != nil {
				return lerr
			}
			d2.mu.Lock()
			d2.ln = ln
			d2.mu.Unlock()
			d2.stopped.Store(false)
			go d2.serve(ln)
			t.Cleanup(d2.stop)
			d2.register(t, os.Getpid())
			return nil
		},
	})
	t.Cleanup(func() { _ = sess.Close() })

	sess.MarkTurnInFlight()

	// Simulate SIGKILL: stop the first daemon's listener, drop its conns, and
	// overwrite the registry with a dead-pid record so recovery must respawn.
	d1.stop()
	d1.dropConnections()
	writeRecordAtomically(t, agentDir, cwd, NeoDaemonRecord{
		Version: NeoDaemonProtocolVersion, Socket: d1.socket, PID: 4_000_000_000, Token: "tok-1",
	})

	if err := sess.WaitRecovered(4 * time.Second); err != nil {
		t.Fatalf("did not recover after SIGKILL: %v; snapshot=%+v", err, sess.Snapshot())
	}
	snap := sess.Snapshot()
	if !snap.InFlightTurnAborted {
		t.Fatalf("in-flight turn must be aborted after SIGKILL: %+v", snap)
	}
	if snap.Status != RecoveryConnected {
		t.Fatalf("expected reconnected status after respawn, got %v", snap.Status)
	}
	if d2.accepts.Load() == 0 {
		t.Fatalf("respawned daemon was never attached to")
	}
}
