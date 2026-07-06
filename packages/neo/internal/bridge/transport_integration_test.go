package bridge

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// repoRootForTest walks up from the test's working directory to the senpi repo
// root (identified by packages/coding-agent/src/cli.ts). Returns "" if not found.
func repoRootForTest(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		if _, statErr := os.Stat(filepath.Join(dir, "packages", "coding-agent", "src", "cli.ts")); statErr == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// rpcSandbox is an isolated CLI run environment: repo root, agent dir, and the
// child env, all pointed away from the real ~/.senpi.
type rpcSandbox struct {
	root     string
	agentDir string
	cli      string
	env      []string
	pre      []string
}

// newRPCSandbox creates the isolated sandbox and skips the test if the TS CLI /
// node / tsx prerequisites are missing.
func newRPCSandbox(t *testing.T) rpcSandbox {
	t.Helper()
	root := repoRootForTest(t)
	if root == "" {
		t.Skip("senpi repo root not found; integration test needs the TS CLI")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH; integration test needs node")
	}
	tsx := filepath.Join(root, "node_modules", "tsx", "dist", "cli.mjs")
	if _, err := os.Stat(tsx); err != nil {
		t.Skip("tsx not installed (run npm ci --ignore-scripts); skipping integration test")
	}
	cli := filepath.Join(root, "packages", "coding-agent", "src", "cli.ts")

	sandbox := t.TempDir()
	home := filepath.Join(sandbox, "home")
	agentDir := filepath.Join(sandbox, "agent")
	sessionDir := filepath.Join(sandbox, "sessions")
	work := filepath.Join(sandbox, "work")
	for _, d := range []string{home, agentDir, sessionDir, work} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir sandbox: %v", err)
		}
	}

	env := append(os.Environ(),
		"HOME="+home,
		"SENPI_CODING_AGENT_DIR="+agentDir,
		"SENPI_CODING_AGENT_SESSION_DIR="+sessionDir,
		"PI_OFFLINE=1",
		"PI_TELEMETRY=0",
		"PAGER=cat",
		"GIT_PAGER=cat",
	)
	return rpcSandbox{
		root:     root,
		agentDir: agentDir,
		env:      env,
		pre:      []string{tsx, "--tsconfig", filepath.Join(root, "tsconfig.json")},
		cli:      cli,
	}
}

// config builds a StdioTransportConfig for this sandbox with extra CLI args.
func (s rpcSandbox) config(work string, extraArgs ...string) StdioTransportConfig {
	return StdioTransportConfig{
		NodePath:   "node",
		PreCLIArgs: s.pre,
		CLIPath:    s.cli,
		ExtraArgs:  append([]string{"--no-session", "--no-context-files"}, extraArgs...),
		Dir:        work,
		Env:        s.env,
		InitWait:   700 * time.Millisecond, // tsx cold-start is slower than a built binary
	}
}

// isolatedRPCConfig preserves the simpler helper used by the get_state/kill tests.
func isolatedRPCConfig(t *testing.T, extraArgs ...string) StdioTransportConfig {
	t.Helper()
	s := newRPCSandbox(t)
	return s.config(filepath.Dir(s.agentDir), extraArgs...)
}

// realAuthPath returns the real ~/.senpi/agent/auth.json path from the ambient
// (pre-sandbox) environment, used to assert the isolation invariant.
func realAuthPath(t *testing.T) string {
	t.Helper()
	if d := os.Getenv("SENPI_CODING_AGENT_DIR"); d != "" {
		return filepath.Join(d, "auth.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".senpi", "agent", "auth.json")
}

func hashFileOrEmpty(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		return "" // absent is a valid state
	}
	return string(b)
}

// TestIntegrationRealRPCGetState spawns the REAL `senpi --mode rpc` via
// StdioTransport and round-trips get_state through the Client. It asserts the
// isolation invariant: the real auth.json is unchanged.
func TestIntegrationRealRPCGetState(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping RPC integration test in -short mode")
	}
	authPath := realAuthPath(t)
	before := hashFileOrEmpty(t, authPath)

	cfg := isolatedRPCConfig(t)
	tr, err := NewStdioTransport(cfg)
	if err != nil {
		t.Fatalf("spawn rpc: %v", err)
	}
	t.Cleanup(func() {
		if cerr := tr.Close(); cerr != nil {
			t.Logf("transport close: %v", cerr)
		}
	})

	client := NewClient(tr)
	resp, err := client.Request(Command{Type: "get_state"}, 30*time.Second)
	if err != nil {
		t.Fatalf("get_state: %v; stderr: %s", err, tr.Stderr())
	}
	if resp.Command != "get_state" || !resp.Success {
		t.Fatalf("unexpected get_state response: %+v", resp)
	}
	var state RPCSessionState
	if uerr := json.Unmarshal(resp.Data, &state); uerr != nil {
		t.Fatalf("decode state: %v", uerr)
	}
	if state.SessionID == "" {
		t.Fatalf("state missing sessionId: %+v", state)
	}

	after := hashFileOrEmpty(t, authPath)
	if before != after {
		t.Fatalf("ISOLATION VIOLATION: real auth.json changed at %s", authPath)
	}
}

// TestIntegrationKillChildTypedExitError spawns the real RPC child, kills it
// mid-request, and asserts the pending request fails with the typed exit error
// carrying captured stderr context (rpc-client.ts createProcessExitError parity).
func TestIntegrationKillChildTypedExitError(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping RPC integration test in -short mode")
	}
	cfg := isolatedRPCConfig(t)
	tr, err := NewStdioTransport(cfg)
	if err != nil {
		t.Fatalf("spawn rpc: %v", err)
	}
	client := NewClient(tr)

	// Kill the child out from under an in-flight request.
	go func() {
		time.Sleep(150 * time.Millisecond)
		if tr.cmd.Process != nil {
			if kerr := tr.cmd.Process.Kill(); kerr != nil {
				t.Logf("kill child: %v", kerr)
			}
		}
	}()

	// get_state normally resolves fast; a very long timeout ensures the failure
	// we observe is the process death, not our own deadline.
	_, reqErr := client.Request(Command{Type: "get_state"}, 25*time.Second)
	// Depending on timing get_state may have already answered; if so, issue a
	// second request that must now fail because the child is gone.
	if reqErr == nil {
		<-tr.Done()
		_, reqErr = client.Request(Command{Type: "get_state"}, 5*time.Second)
	}
	if reqErr == nil {
		t.Fatalf("expected a typed error after child kill")
	}
	if !errors.Is(reqErr, ErrProcessExited) && !errors.Is(reqErr, ErrClientClosed) {
		t.Fatalf("expected ErrProcessExited/ErrClientClosed, got: %v", reqErr)
	}
	// The child was SIGKILLed above, so it has definitively exited; wait for the
	// reaper to record the typed exit error before asserting. ExitError() MUST be
	// populated (a nil here would let the stderr-context claim pass vacuously) and
	// MUST carry the "stderr:" context field (rpc-client.ts createProcessExitError
	// parity — the field is present even when the SIGKILL left stderr empty).
	<-tr.Done()
	xe := tr.ExitError()
	if xe == nil {
		t.Fatalf("expected a populated typed ExitError after child kill, got nil")
	}
	if !strings.Contains(xe.Error(), "stderr") {
		t.Fatalf("exit error should carry stderr context: %v", xe)
	}
	if cerr := tr.Close(); cerr != nil {
		t.Logf("transport close: %v", cerr)
	}
}

// startFakeModelServer launches the senpi-qa fake model server (node) and
// returns its base URL. The server serves a single scripted turn so a real
// prompt drives to agent_end with ZERO real provider calls.
func startFakeModelServer(t *testing.T, s rpcSandbox) (string, func()) {
	t.Helper()
	launcher := filepath.Join(t.TempDir(), "fake-server.mjs")
	fakeMjs := filepath.Join(s.root, ".agents", "skills", "senpi-qa", "scripts", "lib", "fake-model-server.mjs")
	script := "import { startFakeModelServer } from " + strconv.Quote(fakeMjs) + ";\n" +
		"const server = await startFakeModelServer({ turns: [{ text: \"NEO-BRIDGE-QA-PONG\" }] });\n" +
		"process.stdout.write(server.url + \"\\n\");\n" +
		"setInterval(() => {}, 1 << 30);\n"
	if err := os.WriteFile(launcher, []byte(script), 0o644); err != nil {
		t.Fatalf("write fake server launcher: %v", err)
	}
	cmd := exec.Command("node", launcher)
	cmd.Env = s.env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("fake server stdout pipe: %v", err)
	}
	if serr := cmd.Start(); serr != nil {
		t.Fatalf("start fake server: %v", serr)
	}
	stop := func() {
		if cmd.Process != nil {
			if kerr := cmd.Process.Kill(); kerr != nil {
				t.Logf("kill fake server: %v", kerr)
			}
		}
	}
	// First stdout line is the base URL.
	br := bufio.NewReader(stdout)
	line, err := br.ReadString('\n')
	if err != nil {
		stop()
		t.Fatalf("read fake server url: %v", err)
	}
	return strings.TrimSpace(line), stop
}

// TestIntegrationRealRPCMockLoop is the verbatim happy-path manual-QA scenario as
// an automated test: against the REAL `senpi --mode rpc` + a mock model server,
// run get_state, prompt -> agent_end, and get_commands. Isolation invariant is
// asserted (real auth.json unchanged).
func TestIntegrationRealRPCMockLoop(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping RPC integration test in -short mode")
	}
	s := newRPCSandbox(t)
	authPath := realAuthPath(t)
	before := hashFileOrEmpty(t, authPath)

	baseURL, stopServer := startFakeModelServer(t, s)
	t.Cleanup(stopServer)
	t.Logf("fake model server: %s", baseURL)

	writeMockModelsJSON(t, s.agentDir, baseURL)

	work := filepath.Dir(s.agentDir)
	cfg := s.config(work, "--no-extensions", "--provider", "mock", "--model", "mock-model")
	tr, err := NewStdioTransport(cfg)
	if err != nil {
		t.Fatalf("spawn rpc: %v", err)
	}
	t.Cleanup(func() {
		if cerr := tr.Close(); cerr != nil {
			t.Logf("transport close: %v", cerr)
		}
	})
	client := NewClient(tr)

	// 1) get_state
	st, err := client.Request(Command{Type: "get_state"}, 30*time.Second)
	if err != nil {
		t.Fatalf("get_state: %v; stderr: %s", err, tr.Stderr())
	}
	var state RPCSessionState
	if uerr := json.Unmarshal(st.Data, &state); uerr != nil {
		t.Fatalf("decode state: %v", uerr)
	}
	t.Logf("get_state OK: sessionId=%s messageCount=%d", state.SessionID, state.MessageCount)

	// 2) prompt -> agent_end
	agentEnd := make(chan struct{}, 1)
	client.OnEvent(func(e Event) {
		if e.Type == "agent_end" {
			select {
			case agentEnd <- struct{}{}:
			default:
			}
		}
	})
	ack, err := client.Request(Command{Type: "prompt", Fields: map[string]any{"message": "Reply with the marker."}}, 30*time.Second)
	if err != nil {
		t.Fatalf("prompt: %v; stderr: %s", err, tr.Stderr())
	}
	if ack.Command != "prompt" || !ack.Success {
		t.Fatalf("prompt ack unexpected: %+v", ack)
	}
	select {
	case <-agentEnd:
		t.Logf("observed agent_end after prompt")
	case <-time.After(60 * time.Second):
		t.Fatalf("no agent_end within 60s; stderr: %s", tr.Stderr())
	}

	// 3) get_commands
	cmds, err := client.Request(Command{Type: "get_commands"}, 30*time.Second)
	if err != nil {
		t.Fatalf("get_commands: %v", err)
	}
	var cd struct {
		Commands []RPCSlashCommand `json:"commands"`
	}
	if uerr := json.Unmarshal(cmds.Data, &cd); uerr != nil {
		t.Fatalf("decode commands: %v", uerr)
	}
	if len(cd.Commands) == 0 {
		t.Fatalf("get_commands returned no commands")
	}
	t.Logf("get_commands OK: %d commands", len(cd.Commands))

	if after := hashFileOrEmpty(t, authPath); before != after {
		t.Fatalf("ISOLATION VIOLATION: real auth.json changed at %s", authPath)
	}
}

// writeMockModelsJSON writes an isolated models.json pointing the "mock" provider
// at the fake server's base URL (mirrors senpi-qa mock-loop).
func writeMockModelsJSON(t *testing.T, agentDir, baseURL string) {
	t.Helper()
	cfg := map[string]any{
		"providers": map[string]any{
			"mock": map[string]any{
				"baseUrl": baseURL,
				"apiKey":  "sk-mock-neo-bridge-qa",
				"api":     "openai-completions",
				"models": []any{map[string]any{
					"id": "mock-model", "baseUrl": baseURL, "api": "openai-completions",
					"contextWindow": 128000, "maxTokens": 4096,
					"cost": map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
				}},
			},
		},
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatalf("marshal models.json: %v", err)
	}
	if werr := os.WriteFile(filepath.Join(agentDir, "models.json"), b, 0o644); werr != nil {
		t.Fatalf("write models.json: %v", werr)
	}
}
