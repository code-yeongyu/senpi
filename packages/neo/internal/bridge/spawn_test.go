package bridge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestSpawnDaemonDetached_BareCLIRunsViaNode proves a single bare CLI token
// (e.g. `.../src/cli.ts`, the form neo-test.sh sets by default) is launched as
// `node <cli> --listen ... --register`, NOT exec'd directly. Direct exec of a
// .ts fails "permission denied" — the daemon-mode spawn regression qa found.
func TestSpawnDaemonDetached_BareCLIRunsViaNode(t *testing.T) {
	// A bare .ts path: not executable. Direct exec would fail with permission
	// denied; the node-fallback must run it under `node` and succeed to start.
	dir := t.TempDir()
	cli := filepath.Join(dir, "cli.ts")
	if err := os.WriteFile(cli, []byte("process.exit(0)\n"), 0o644); err != nil {
		t.Fatalf("write cli: %v", err)
	}
	t.Setenv(EnvNeoCLIPath, cli) // single bare token, no `node` prefix

	// Use a fake `node` on PATH that records its argv and exits 0, so the test is
	// hermetic (no real node needed) and asserts the resolved command line.
	bin := t.TempDir()
	logFile := filepath.Join(bin, "argv.log")
	script := "#!/bin/sh\necho \"$@\" > " + logFile + "\nexit 0\n"
	if err := os.WriteFile(filepath.Join(bin, "node"), []byte(script), 0o755); err != nil {
		t.Fatalf("write fake node: %v", err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	err := SpawnDaemonDetached(SpawnRequest{Socket: "/tmp/sock", AgentDir: dir, Cwd: dir})
	if err != nil {
		t.Fatalf("SpawnDaemonDetached with a bare .ts must succeed via node, got: %v", err)
	}
	// Give the detached child a moment to write; poll bounded.
	var got string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b, e := os.ReadFile(logFile); e == nil && len(b) > 0 {
			got = string(b)
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(got, "cli.ts") || !strings.Contains(got, "--listen") || !strings.Contains(got, "--register") {
		t.Fatalf("node must be invoked as `node <cli.ts> --listen ... --register`, argv was: %q", got)
	}
}

// TestSpawnDaemonDetached_PinsAgentDirEnv proves the spawner sets the agent-dir
// (and session-dir) env vars in the daemon's environment from the request,
// rather than relying on ambient inheritance — without which a detached daemon
// can register into ~/.senpi while the client polls a sandbox and times out.
func TestSpawnDaemonDetached_PinsAgentDirEnv(t *testing.T) {
	bin := t.TempDir()
	logFile := filepath.Join(bin, "env.log")
	// Fake node dumps the two pinned env vars and exits 0.
	script := "#!/bin/sh\n{ echo \"AD=$MYAPP_CODING_AGENT_DIR\"; echo \"SD=$MYAPP_CODING_AGENT_SESSION_DIR\"; } > " + logFile + "\nexit 0\n"
	if err := os.WriteFile(filepath.Join(bin, "node"), []byte(script), 0o755); err != nil {
		t.Fatalf("write fake node: %v", err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	cli := filepath.Join(t.TempDir(), "cli.ts")
	if err := os.WriteFile(cli, []byte("//x\n"), 0o644); err != nil {
		t.Fatalf("write cli: %v", err)
	}
	t.Setenv(EnvNeoCLIPath, cli)

	err := SpawnDaemonDetached(SpawnRequest{
		Socket:            "/tmp/sock",
		Cwd:               bin,
		AgentDir:          "/sandbox/agent",
		AgentDirEnvName:   "MYAPP_CODING_AGENT_DIR",
		SessionDir:        "/sandbox/sessions",
		SessionDirEnvName: "MYAPP_CODING_AGENT_SESSION_DIR",
	})
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	var got string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b, e := os.ReadFile(logFile); e == nil && len(b) > 0 {
			got = string(b)
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(got, "AD=/sandbox/agent") {
		t.Fatalf("daemon env must pin the agent dir, got: %q", got)
	}
	if !strings.Contains(got, "SD=/sandbox/sessions") {
		t.Fatalf("daemon env must pin the session dir, got: %q", got)
	}
}
