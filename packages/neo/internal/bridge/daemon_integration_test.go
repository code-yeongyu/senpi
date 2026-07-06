package bridge

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// These integration tests drive the REAL task-15 TypeScript daemon (via tsx) so
// the Go attach-or-spawn client is exercised end-to-end against the actual wire
// protocol, not a Go stand-in. They are hermetic (sandbox agent dir, mock
// models.json pointing at an unreachable base URL, provider keys stripped) and
// skipped in -short mode / when node+tsx are unavailable.

// daemonSandbox is an isolated CLI run environment for the daemon integration.
type daemonSandbox struct {
	root     string
	agentDir string
	cwd      string
	cliCmd   []string // node <tsx> --tsconfig <cfg> <cli.ts>
	env      []string
}

func newDaemonSandbox(t *testing.T) daemonSandbox {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping daemon integration test in -short mode")
	}
	root := repoRootForTest(t)
	if root == "" {
		t.Skip("senpi repo root not found; daemon integration needs the TS CLI")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH")
	}
	tsx := filepath.Join(root, "node_modules", "tsx", "dist", "cli.mjs")
	if _, err := os.Stat(tsx); err != nil {
		t.Skip("tsx not installed (run npm ci --ignore-scripts)")
	}
	cli := filepath.Join(root, "packages", "coding-agent", "src", "cli.ts")
	tsconfig := filepath.Join(root, "tsconfig.json")

	sandbox := t.TempDir()
	// Resolve symlinks so the cwd-key matches the daemon's process.cwd()-derived
	// key (macOS /var -> /private/var).
	if resolved, err := filepath.EvalSymlinks(sandbox); err == nil {
		sandbox = resolved
	}
	agentDir := filepath.Join(sandbox, "agent")
	cwd := filepath.Join(sandbox, "work")
	for _, d := range []string{agentDir, cwd} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeMockModels(t, agentDir)

	cliCmd := []string{"node", tsx, "--tsconfig", tsconfig, cli}
	workerArgs, _ := json.Marshal([]string{tsx, "--tsconfig", tsconfig, cli})
	env := append(os.Environ(),
		"SENPI_CODING_AGENT_DIR="+agentDir,
		"PI_OFFLINE=1", "PI_TELEMETRY=0",
		"SENPI_NEO_WORKER_ARGS="+string(workerArgs),
	)
	for _, k := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY"} {
		env = filterEnv(env, k)
	}
	return daemonSandbox{root: root, agentDir: agentDir, cwd: cwd, cliCmd: cliCmd, env: env}
}

func writeMockModels(t *testing.T, agentDir string) {
	t.Helper()
	cfg := `{"providers":{"anthropic":{"baseUrl":"http://127.0.0.1:9/","apiKey":"x","api":"anthropic-messages","models":[{"id":"mock-claude","baseUrl":"http://127.0.0.1:9/","api":"anthropic-messages","contextWindow":128000,"maxTokens":4096,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}`
	if err := os.WriteFile(filepath.Join(agentDir, "models.json"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
}

func filterEnv(env []string, key string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if len(kv) > len(key) && kv[:len(key)+1] == key+"=" {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// startRealDaemon spawns the daemon supervisor directly (not via the Go client's
// SpawnDaemonDetached, so the test controls its env) on the given socket and
// waits until it registers.
func startRealDaemon(t *testing.T, sb daemonSandbox, socket string) *exec.Cmd {
	t.Helper()
	args := append(append([]string{}, sb.cliCmd[1:]...), "--listen", socket, "--register")
	cmd := exec.Command(sb.cliCmd[0], args...)
	cmd.Dir = sb.cwd
	cmd.Env = sb.env
	logf, _ := os.Create(filepath.Join(sb.agentDir, "daemon.log"))
	if logf != nil {
		cmd.Stdout = logf
		cmd.Stderr = logf
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start daemon: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		if logf != nil {
			_ = logf.Close()
		}
	})
	// Wait for registration (tsx cold-start; the daemon self-registers after bind).
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		if rec, _ := ReadNeoDaemonRecord(sb.agentDir, sb.cwd); rec != nil {
			return cmd
		}
		time.Sleep(200 * time.Millisecond)
	}
	dumpDaemonLog(t, sb.agentDir)
	t.Fatalf("daemon did not register within 40s")
	return nil
}

func dumpDaemonLog(t *testing.T, agentDir string) {
	t.Helper()
	if b, err := os.ReadFile(filepath.Join(agentDir, "daemon.log")); err == nil {
		t.Logf("daemon.log:\n%s", string(b))
	}
}

// TestIntegrationAttachToHealthyRealDaemon: start a real daemon, then assert the
// Go client attaches (handshake welcome) and can round-trip get_state through it.
func TestIntegrationAttachToHealthyRealDaemon(t *testing.T) {
	sb := newDaemonSandbox(t)
	socket := shortSocketPath(t)
	startRealDaemon(t, sb, socket)

	conn, err := AttachOrSpawn(AttachConfig{
		AgentDir:       sb.agentDir,
		Cwd:            sb.cwd,
		RuntimeOptions: NeoRuntimeOptions{Model: strPtr("mock-claude")},
		// A spawner that fails: the healthy daemon must be attached WITHOUT spawning.
		Spawn:   func(SpawnRequest) error { t.Fatalf("spawn must not be called for a healthy daemon"); return nil },
		Timeout: 45 * time.Second,
	})
	if err != nil {
		dumpDaemonLog(t, sb.agentDir)
		t.Fatalf("AttachOrSpawn: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if conn.Path != PathHealthyAttach {
		t.Fatalf("expected PathHealthyAttach, got %v", conn.Path)
	}

	client := NewClient(conn.Transport)
	resp, err := client.Request(Command{Type: "get_state"}, 30*time.Second)
	if err != nil {
		dumpDaemonLog(t, sb.agentDir)
		t.Fatalf("get_state through daemon: %v", err)
	}
	if resp.Command != "get_state" || !resp.Success {
		t.Fatalf("unexpected get_state: %+v", resp)
	}
}

// TestIntegrationSpawnRealDaemon: no daemon present → the Go client's
// SpawnDaemonDetached (via SENPI_NEO_CLI_PATH) starts one and attaches.
func TestIntegrationSpawnRealDaemon(t *testing.T) {
	sb := newDaemonSandbox(t)
	// Point the client's default spawner at the tsx CLI.
	t.Setenv("SENPI_NEO_CLI_PATH", sb.cliCmd[0]+" "+sb.cliCmd[1]+" "+sb.cliCmd[2]+" "+sb.cliCmd[3]+" "+sb.cliCmd[4])
	// The daemon spawned by the client inherits this process's env; make sure the
	// worker args + agent dir are set here too.
	for _, kv := range sb.env {
		if i := indexByte(kv, '='); i > 0 {
			t.Setenv(kv[:i], kv[i+1:])
		}
	}

	conn, err := AttachOrSpawn(AttachConfig{
		AgentDir:       sb.agentDir,
		Cwd:            sb.cwd,
		RuntimeOptions: NeoRuntimeOptions{Model: strPtr("mock-claude")},
		Timeout:        60 * time.Second,
	})
	if err != nil {
		dumpDaemonLog(t, sb.agentDir)
		t.Fatalf("AttachOrSpawn (spawn path): %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
		// The client spawned a detached daemon; kill it so no orphan survives.
		if rec, _ := ReadNeoDaemonRecord(sb.agentDir, sb.cwd); rec != nil {
			if p, perr := os.FindProcess(rec.PID); perr == nil {
				_ = p.Kill()
			}
		}
	})
	if conn.Path != PathSpawned {
		t.Fatalf("expected PathSpawned, got %v", conn.Path)
	}
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}
