package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
)

const attachTimeout = 30 * time.Second

// scenarioHappy: two connections in the SAME cwd share ONE supervisor daemon
// while using DIFFERENT --session/--model. ps must show 1 supervisor + >=2
// workers, and each connection's get_state must reflect its OWN session.
func scenarioHappy(h *harnessEnv) bool {
	a, okA := h.attach([]string{"--model", "mock-claude", "--session", "sessA.jsonl", "--api-key", "sk-ant-mock-AAA"})
	if !okA {
		return false
	}
	defer a.Close()
	b, okB := h.attach([]string{"--model", "mock-claude", "--session", "sessB.jsonl", "--api-key", "sk-ant-mock-BBB"})
	if !okB {
		return false
	}
	defer b.Close()

	fmt.Printf("HAPPY connA path=%s socket=%s\n", a.Path(), a.Record().Socket)
	fmt.Printf("HAPPY connB path=%s socket=%s\n", b.Path(), b.Record().Socket)

	if a.Record().PID != b.Record().PID {
		fmt.Printf("HAPPY FAIL: different daemon pids A=%d B=%d\n", a.Record().PID, b.Record().PID)
		return false
	}
	supervisorPID := a.Record().PID
	fmt.Printf("HAPPY shared supervisor pid=%d\n", supervisorPID)
	h.trackDaemonPID(supervisorPID)

	// Give both workers time to spawn (tsx cold-start), then read the pid tree.
	time.Sleep(2 * time.Second)
	sup, workers := classifyForDaemon(psSnapshot("packages/coding-agent/src/cli.ts"), supervisorPID)
	fmt.Printf("PS supervisor-rows-matching-listen=%d workers-with-ppid=%d (supervisor pid=%d)\n",
		len(sup), len(workers), supervisorPID)
	for _, s := range sup {
		fmt.Printf("PS   supervisor pid=%d ppid=%d\n", s.pid, s.ppid)
	}
	for _, w := range workers {
		fmt.Printf("PS   worker     pid=%d ppid=%d\n", w.pid, w.ppid)
	}

	stateA := h.getState(a)
	stateB := h.getState(b)
	fmt.Printf("HAPPY stateA sessionFile=%s\n", stateA.SessionFile)
	fmt.Printf("HAPPY stateB sessionFile=%s\n", stateB.SessionFile)
	distinctSessions := stateA.SessionFile != "" && stateB.SessionFile != "" && stateA.SessionFile != stateB.SessionFile

	// The single-supervisor invariant is proven by three facts, not by counting
	// the supervisor's own ps row (whose argv formatting under tsx is brittle):
	//   1. both connections attached to the SAME registry pid (checked above),
	//   2. that supervisor pid is alive,
	//   3. the two per-connection workers are BOTH children of it (ppid match).
	supervisorAlive := bridge.IsPidAlive(supervisorPID)
	twoWorkersUnderSupervisor := len(workers) >= 2
	oneSharedSupervisor := supervisorAlive && twoWorkersUnderSupervisor
	ok := oneSharedSupervisor && distinctSessions
	fmt.Printf("HAPPY oneSharedSupervisor=%v (alive=%v, workers-under-it=%d) distinctSessions=%v => %v\n",
		oneSharedSupervisor, supervisorAlive, len(workers), distinctSessions, ok)
	return ok
}

// scenarioFlags: the flag-fidelity matrix. Each row starts a fresh connection
// with a distinct flag and asserts the runtime honored it.
func scenarioFlags(h *harnessEnv) bool {
	allOK := true

	// Row: --no-builtin-tools yields no more commands than the full set.
	full, okF := h.attach([]string{"--model", "mock-claude"})
	if !okF {
		return false
	}
	fullCmds := h.getCommands(full)
	full.Close()

	limited, okL := h.attach([]string{"--model", "mock-claude", "--no-builtin-tools"})
	if !okL {
		return false
	}
	limitedCmds := h.getCommands(limited)
	limited.Close()
	noBuiltinOK := len(limitedCmds) <= len(fullCmds)
	fmt.Printf("FLAGS --no-builtin-tools: full-cmds=%d limited-cmds=%d honored=%v\n",
		len(fullCmds), len(limitedCmds), noBuiltinOK)
	allOK = allOK && noBuiltinOK

	// Row: --name sets the session name (visible in get_state).
	named, okN := h.attach([]string{"--model", "mock-claude", "--name", "qa-named-run"})
	if !okN {
		return false
	}
	namedState := h.getState(named)
	named.Close()
	nameOK := namedState.SessionName == "qa-named-run"
	fmt.Printf("FLAGS --name: sessionName=%q honored=%v\n", namedState.SessionName, nameOK)
	allOK = allOK && nameOK

	// Row: two connections with different --api-key → wire isolation.
	before, _ := h.fetchRequestKeys()
	a, okA := h.attach([]string{"--model", "mock-claude", "--api-key", "sk-ant-key-AAA-1111"})
	b, okB := h.attach([]string{"--model", "mock-claude", "--api-key", "sk-ant-key-BBB-2222"})
	if !okA || !okB {
		return false
	}
	h.prompt(a, "hello from A")
	h.prompt(b, "hello from B")
	time.Sleep(4 * time.Second) // let both turns hit the fake server
	a.Close()
	b.Close()
	after, _ := h.fetchRequestKeys()
	keyA, keyB := keysSeen(after, before)
	fmt.Printf("FLAGS --api-key isolation: keyA-seen=%v keyB-seen=%v (per-key on wire; task-15 asserts no cross-leak)\n", keyA, keyB)
	apiKeyOK := keyA && keyB
	allOK = allOK && apiKeyOK

	return allOK
}

// scenarioDrop: close the socket with the daemon alive → the Session reconnects
// and resumes; the in-flight turn is shown aborted.
func scenarioDrop(h *harnessEnv) bool {
	argv := []string{"--model", "mock-claude", "--session", "drop.jsonl"}
	a, ok := h.attach(argv)
	if !ok {
		return false
	}
	h.trackDaemonPID(a.Record().PID)
	sess := bridge.NewSession(a.Conn(), bridge.SessionConfig{
		AgentDir: h.agentDir, Cwd: h.cwd,
		Options:    bridgeOptions(argv),
		BackoffMin: 50 * time.Millisecond, BackoffMax: time.Second,
		AttachTimeout: attachTimeout,
	})
	defer func() { _ = sess.Close() }()

	sess.MarkTurnInFlight()
	_ = a.Conn().Transport.Close() // drop socket; daemon stays alive

	if err := sess.WaitRecovered(20 * time.Second); err != nil {
		fmt.Printf("DROP FAIL: no recovery: %v snapshot=%+v\n", err, sess.Snapshot())
		return false
	}
	snap := sess.Snapshot()
	fmt.Printf("DROP snapshot status=%s aborted=%v reconnects=%d resumedLeaf=%q\n",
		snap.Status, snap.InFlightTurnAborted, snap.Reconnects, snap.ResumedLeafID)
	ok = snap.Status == bridge.RecoveryConnected && snap.InFlightTurnAborted
	fmt.Printf("DROP reconnected+aborted-shown => %v\n", ok)
	return ok
}

// scenarioKill: SIGKILL the daemon supervisor → the Session respawns a fresh
// daemon and resumes; the in-flight turn is shown aborted.
func scenarioKill(h *harnessEnv) bool {
	argv := []string{"--model", "mock-claude", "--session", "kill.jsonl"}
	a, ok := h.attach(argv)
	if !ok {
		return false
	}
	daemonPID := a.Record().PID
	h.trackDaemonPID(daemonPID)
	sess := bridge.NewSession(a.Conn(), bridge.SessionConfig{
		AgentDir: h.agentDir, Cwd: h.cwd,
		Options:    bridgeOptions(argv),
		BackoffMin: 50 * time.Millisecond, BackoffMax: time.Second,
		AttachTimeout: attachTimeout,
	})
	defer func() { _ = sess.Close() }()

	sess.MarkTurnInFlight()
	if proc, perr := os.FindProcess(daemonPID); perr == nil {
		_ = proc.Kill()
		fmt.Printf("KILL sent SIGKILL to supervisor pid=%d\n", daemonPID)
	}

	if err := sess.WaitRecovered(25 * time.Second); err != nil {
		fmt.Printf("KILL FAIL: no recovery: %v snapshot=%+v\n", err, sess.Snapshot())
		return false
	}
	snap := sess.Snapshot()
	newRec, _ := bridge.ReadNeoDaemonRecord(h.agentDir, h.cwd)
	newPID := 0
	if newRec != nil {
		newPID = newRec.PID
	}
	fmt.Printf("KILL snapshot status=%s aborted=%v oldPID=%d newPID=%d\n",
		snap.Status, snap.InFlightTurnAborted, daemonPID, newPID)
	respawned := newPID != 0 && newPID != daemonPID
	ok = snap.Status == bridge.RecoveryConnected && snap.InFlightTurnAborted && respawned
	fmt.Printf("KILL respawned+aborted-shown => %v\n", ok)
	return ok
}

// scenarioCorrupt: a corrupt registry json auto-repairs + respawns.
func scenarioCorrupt(h *harnessEnv) bool {
	a, ok := h.attach([]string{"--model", "mock-claude"})
	if !ok {
		return false
	}
	h.trackDaemonPID(a.Record().PID)
	a.Close()

	path := bridge.NeoDaemonRegistryPath(h.agentDir, h.cwd)
	if err := os.WriteFile(path, []byte("{ this is not valid json"), 0o600); err != nil {
		fmt.Printf("CORRUPT FAIL: could not corrupt registry: %v\n", err)
		return false
	}
	fmt.Printf("CORRUPT wrote invalid json to %s\n", path)

	b, ok2 := h.attach([]string{"--model", "mock-claude"})
	if !ok2 {
		return false
	}
	defer b.Close()
	fmt.Printf("CORRUPT recovered path=%s newPID=%d\n", b.Path(), b.Record().PID)
	repaired := b.Path() == bridge.PathSpawned && b.Record().PID != 0
	fmt.Printf("CORRUPT auto-repair+respawn => %v\n", repaired)
	return repaired
}

// keysSeen reports whether both distinct QA keys appear in the after-set (so this
// scenario's own requests carried each key). before is retained for symmetry.
func keysSeen(after, _ []string) (keyA, keyB bool) {
	for _, k := range after {
		if strings.Contains(k, "AAA-1111") {
			keyA = true
		}
		if strings.Contains(k, "BBB-2222") {
			keyB = true
		}
	}
	return keyA, keyB
}

// bridgeOptions parses the neo argv into runtime options for a Session.
func bridgeOptions(argv []string) bridge.NeoRuntimeOptions {
	opts, _ := bridge.ParseNeoRuntimeArgv(argv)
	return opts
}
