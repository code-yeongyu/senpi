package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// harnessEnv holds the hermetic environment shared by every scenario: the
// sandbox agent dir, the CLI/worker command wiring, the fake-server sidecar, and
// the cwd every connection shares.
type harnessEnv struct {
	repoRoot     string
	agentDir     string
	cwd          string
	cliCmd       string // SENPI_NEO_CLI_PATH value
	sidecar      *exec.Cmd
	controlPort  string
	origin       string
	realAuthHash string
	daemonPIDs   map[int]struct{}
	cleanups     []func()
}

func setupHarness() (*harnessEnv, error) {
	root, err := repoRoot()
	if err != nil {
		return nil, err
	}
	tsx := filepath.Join(root, "node_modules", "tsx", "dist", "cli.mjs")
	if _, err := os.Stat(tsx); err != nil {
		return nil, fmt.Errorf("tsx not installed (run npm ci --ignore-scripts at repo root): %w", err)
	}
	cli := filepath.Join(root, "packages", "coding-agent", "src", "cli.ts")
	tsconfig := filepath.Join(root, "tsconfig.json")

	sandbox, err := os.MkdirTemp("", "neo-t17-qa-")
	if err != nil {
		return nil, err
	}
	agentDir := filepath.Join(sandbox, "agent")
	cwd := filepath.Join(sandbox, "work")
	for _, d := range []string{agentDir, cwd} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	// The daemon derives its registry cwd-key from process.cwd(), which the OS
	// returns symlink-resolved (e.g. macOS /var -> /private/var). The Go client
	// must derive the SAME key, so resolve the sandbox cwd's symlinks here to
	// match — otherwise the client polls a registry file the daemon never writes.
	if resolved, rerr := filepath.EvalSymlinks(cwd); rerr == nil {
		cwd = resolved
	}
	fmt.Printf("SANDBOX agent dir: %s\n", agentDir)
	fmt.Printf("SANDBOX cwd:       %s\n", cwd)

	h := &harnessEnv{repoRoot: root, agentDir: agentDir, cwd: cwd, daemonPIDs: map[int]struct{}{}}
	h.addCleanup(func() {
		if rerr := os.RemoveAll(sandbox); rerr == nil {
			fmt.Printf("CLEANUP removed sandbox %s\n", sandbox)
		}
	})

	// Isolation guard: hash the real ~/.senpi/agent/auth.json before + after.
	h.realAuthHash = hashRealAuth()
	fmt.Printf("ISOLATION real auth.json before: %s\n", h.realAuthHash)

	// Start the fake-model-server sidecar and read its origin + control port.
	if err := h.startSidecar(); err != nil {
		return nil, err
	}
	writeMockModelsJSON(agentDir, h.origin)

	// The Go client spawns the daemon supervisor from SENPI_NEO_CLI_PATH, and the
	// daemon spawns each worker from SENPI_NEO_WORKER_ARGS (dev tsx entry).
	h.cliCmd = strings.Join([]string{"node", tsx, "--tsconfig", tsconfig, cli}, " ")
	workerArgs, _ := json.Marshal([]string{tsx, "--tsconfig", tsconfig, cli})
	// The daemon the Go client spawns via SpawnDaemonDetached inherits THIS
	// process's env (cmd.Env is nil). So every hermetic var the daemon + its
	// workers need must be set on the harness process itself — the sandbox agent
	// dir most of all, or the daemon registers in the wrong dir and the client
	// polls the sandbox registry forever. Provider keys are stripped for the same
	// reason (defence in depth; the mock models.json already redirects).
	_ = os.Setenv("SENPI_NEO_CLI_PATH", h.cliCmd)
	_ = os.Setenv("SENPI_NEO_WORKER_ARGS", string(workerArgs))
	_ = os.Setenv("SENPI_CODING_AGENT_DIR", agentDir)
	_ = os.Setenv("PI_OFFLINE", "1")
	_ = os.Setenv("SENPI_ENABLE_NEO", "1")
	_ = os.Setenv("PI_TELEMETRY", "0")
	for _, k := range providerKeyNames() {
		_ = os.Unsetenv(k)
	}

	return h, nil
}

// providerKeyNames lists real provider API-key env vars to strip so nothing can
// reach a real provider from the harness or any child it spawns.
func providerKeyNames() []string {
	return []string{
		"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN",
		"OPENAI_API_KEY", "GEMINI_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY",
	}
}

func (h *harnessEnv) startSidecar() error {
	sidecar := filepath.Join(h.repoRoot, "packages", "neo", "internal", "bridge", "attachqa", "fakeserver.mjs")
	originFile := filepath.Join(h.agentDir, "..", "fake-origin")
	controlFile := filepath.Join(h.agentDir, "..", "fake-control")

	cmd := exec.Command("node", sidecar, originFile, controlFile)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start fakeserver sidecar: %w", err)
	}
	h.sidecar = cmd
	h.addCleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Signal(os.Interrupt)
			done := make(chan struct{})
			go func() { _ = cmd.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				_ = cmd.Process.Kill()
			}
			fmt.Printf("CLEANUP stopped fakeserver sidecar pid=%d\n", cmd.Process.Pid)
		}
	})

	// Poll for the origin + control files the sidecar writes on ready.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		origin, oerr := os.ReadFile(originFile)
		control, cerr := os.ReadFile(controlFile)
		if oerr == nil && cerr == nil && len(origin) > 0 && len(control) > 0 {
			h.origin = strings.TrimSpace(string(origin))
			h.controlPort = strings.TrimSpace(string(control))
			fmt.Printf("FAKE-SERVER origin=%s control=%s\n", h.origin, h.controlPort)
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("fakeserver sidecar did not become ready")
}

// fetchRequestKeys asks the sidecar's control endpoint for the recorded request
// headers so the harness can assert per-connection --api-key isolation on wire.
func (h *harnessEnv) fetchRequestKeys() ([]string, error) {
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%s/requests", h.controlPort))
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	var records []struct {
		Authorization string `json:"authorization"`
		APIKeyHeader  string `json:"apiKeyHeader"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&records); err != nil {
		return nil, err
	}
	var keys []string
	for _, r := range records {
		if r.APIKeyHeader != "" {
			keys = append(keys, r.APIKeyHeader)
		} else if r.Authorization != "" {
			keys = append(keys, r.Authorization)
		}
	}
	return keys, nil
}

func (h *harnessEnv) addCleanup(fn func()) { h.cleanups = append(h.cleanups, fn) }

// trackDaemonPID records a daemon supervisor pid the harness observed so teardown
// can kill it. The last client leaving does NOT kill the daemon (idle timer owns
// lifecycle), so the harness must reap the daemons it spawned for a clean receipt.
func (h *harnessEnv) trackDaemonPID(pid int) {
	if pid > 0 {
		h.daemonPIDs[pid] = struct{}{}
	}
}

func (h *harnessEnv) teardown() {
	// Kill every daemon supervisor this run spawned (tracked pids + any current
	// registry pid + a sweep of cli.ts daemons still bound to this sandbox cwd).
	h.reapDaemons()

	// Run cleanups in reverse registration order.
	for i := len(h.cleanups) - 1; i >= 0; i-- {
		h.cleanups[i]()
	}
	after := hashRealAuth()
	fmt.Printf("ISOLATION real auth.json after:  %s\n", after)
	if after == h.realAuthHash {
		fmt.Println("ISOLATION real auth.json UNCHANGED")
	} else {
		fmt.Println("ISOLATION VIOLATION: real auth.json changed")
	}
}

// reapDaemons kills tracked daemon pids plus whatever the registry currently
// points at, then verifies no cli.ts daemon remains bound to this sandbox cwd.
func (h *harnessEnv) reapDaemons() {
	if rec, _ := bridgeReadRecord(h.agentDir, h.cwd); rec > 0 {
		h.daemonPIDs[rec] = struct{}{}
	}
	killed := 0
	for pid := range h.daemonPIDs {
		if p, err := os.FindProcess(pid); err == nil {
			if p.Kill() == nil {
				killed++
			}
		}
	}
	fmt.Printf("TEARDOWN killed %d tracked daemon supervisor(s)\n", killed)
	// Verify: no worker/supervisor cli.ts proc remains whose cwd registry belongs
	// to this sandbox. A best-effort residual sweep by the sandbox path fragment.
	residual := psSnapshot(h.agentDir)
	fmt.Printf("TEARDOWN residual sandbox-marked procs: %d\n", len(residual))
}
