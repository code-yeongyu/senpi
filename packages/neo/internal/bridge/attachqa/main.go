// Command attachqa is the manual-QA driver for the task-17 attach-or-spawn
// daemon client. Since the Go TUI shell does not exist yet, this harness drives
// bridge.AttachOrSpawn / bridge.Connect / bridge.Session directly and prints
// machine-checkable observables the tmux QA windows and the evidence file assert
// against.
//
// It is hermetic and token-free: a node sidecar (fakeserver.mjs) hosts the
// senpi-qa fake model server, an isolated sandbox agent dir holds a mock
// models.json pointing at it, and the daemon's workers are real
// `senpi --mode rpc` children driven through tsx — so nothing ever reaches a
// real provider. Every daemon/worker/sidecar/socket resource is torn down and a
// receipt is printed.
//
// Scenarios (selected via --scenario):
//
//	happy   - two connections in the SAME cwd share ONE supervisor daemon while
//	          using DIFFERENT --session/--model; ps shows 1 supervisor + N workers.
//	flags   - flag-fidelity matrix: each connection's runtime honors its own
//	          startup flags (asserted via get_commands/get_state).
//	drop    - close the socket with the daemon alive; the Session reconnects and
//	          resumes; the in-flight turn is shown aborted.
//	kill    - SIGKILL the daemon mid-flight; the Session respawns and resumes.
//	corrupt - a corrupt registry json auto-repairs + respawns.
//	all     - run every scenario in sequence (default).
package main

import (
	"fmt"
	"os"
)

func main() {
	scenario := flagArg("--scenario", "all")

	env, err := setupHarness()
	if err != nil {
		fmt.Fprintf(os.Stderr, "SETUP FAILED: %v\n", err)
		os.Exit(1)
	}
	defer env.teardown()

	results := map[string]bool{}
	run := func(name string, fn func(*harnessEnv) bool) {
		if scenario != "all" && scenario != name {
			return
		}
		fmt.Printf("\n==== SCENARIO %s ====\n", name)
		results[name] = fn(env)
		// Capture whatever daemon the scenario left registered so teardown reaps
		// it even after a later scenario overwrites the registry record.
		if pid, _ := bridgeReadRecord(env.agentDir, env.cwd); pid > 0 {
			env.trackDaemonPID(pid)
		}
	}

	run("happy", scenarioHappy)
	run("flags", scenarioFlags)
	run("drop", scenarioDrop)
	run("kill", scenarioKill)
	run("corrupt", scenarioCorrupt)

	fmt.Printf("\n==== RESULTS ====\n")
	allPass := true
	for _, name := range []string{"happy", "flags", "drop", "kill", "corrupt"} {
		ok, ran := results[name]
		if !ran {
			continue
		}
		fmt.Printf("RESULT %-8s %v\n", name, ok)
		allPass = allPass && ok
	}
	if allPass {
		fmt.Println("RESULT ALL-PASS")
		return
	}
	fmt.Println("RESULT FAIL")
	os.Exit(1)
}

func flagArg(name, def string) string {
	for i, a := range os.Args {
		if a == name && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return def
}
