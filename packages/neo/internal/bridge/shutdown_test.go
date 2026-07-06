package bridge

import (
	"os"
	"testing"
	"time"
)

// Clean shutdown (plan task 17): the last client leaving does NOT kill the
// daemon — the idle timer owns lifecycle. Closing a DaemonConn only closes the
// client's own socket; the daemon keeps listening and can still accept a new
// connection.

func TestDaemonConnClose_DoesNotKillDaemon(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/proj/shutdown"
	d := newScriptedDaemon(t, agentDir, cwd, "tok-sd", NeoDaemonProtocolVersion)
	d.register(t, os.Getpid())

	// First client attaches, then closes.
	c1, err := AttachOrSpawn(AttachConfig{AgentDir: agentDir, Cwd: cwd, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("attach c1: %v", err)
	}
	acceptsAfterC1 := d.accepted.Load()
	if acceptsAfterC1 == 0 {
		t.Fatalf("daemon should have accepted c1")
	}
	if cerr := c1.Close(); cerr != nil {
		t.Fatalf("close c1: %v", cerr)
	}

	// The registry record must still be present (the client did not remove it),
	// and a SECOND client must still be able to attach — proving the daemon is
	// alive after the "last" client left.
	rec, rerr := ReadNeoDaemonRecord(agentDir, cwd)
	if rerr != nil || rec == nil {
		t.Fatalf("registry record must survive a client close: %v (err %v)", rec, rerr)
	}

	c2, err := AttachOrSpawn(AttachConfig{AgentDir: agentDir, Cwd: cwd, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("attach c2 after c1 close: %v", err)
	}
	t.Cleanup(func() { _ = c2.Close() })
	if c2.Path != PathHealthyAttach {
		t.Fatalf("c2 must attach to the still-alive daemon (healthy), got %v", c2.Path)
	}
	if d.accepted.Load() <= acceptsAfterC1 {
		t.Fatalf("daemon should have accepted c2 on the same live listener")
	}
}
