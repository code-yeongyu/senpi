package bridge

import (
	"reflect"
	"testing"
	"time"
)

// NeoRuntimeOptionsToRpcArgv is the Go mirror of neo-runtime-options-argv.ts: it
// renders the parsed options into the classic `--mode rpc` argv the isolated
// StdioTransport child (and the daemon's own worker) consumes. Initial inputs
// (messages/fileArgs) are intentionally NOT emitted, matching the TS.

func TestNeoRuntimeOptionsToRpcArgv_MirrorsTS(t *testing.T) {
	opts := NeoRuntimeOptions{
		Provider:       strPtr("anthropic"),
		Model:          strPtr("claude-fable-5"),
		Models:         []string{"a", "b"},
		Thinking:       strPtr("xhigh"),
		APIKey:         strPtr("sk-fake"),
		Session:        strPtr("s.jsonl"),
		SessionDir:     strPtr("/sd"),
		Name:           strPtr("run"),
		NoSession:      boolPtr(true),
		NoBuiltinTools: boolPtr(true),
		NoContextFiles: boolPtr(true),
		Skills:         []string{"commit", "review"},
		Themes:         []string{"grok"},
		Extensions:     []string{"./e.ts"},
		Tools:          []string{"bash", "read"},
		Messages:       []string{"ignored"},
		FileArgs:       []string{"ignored.ts"},
	}
	got := NeoRuntimeOptionsToRpcArgv(opts)

	want := []string{
		"--provider", "anthropic",
		"--model", "claude-fable-5",
		"--models", "a,b",
		"--thinking", "xhigh",
		"--api-key", "sk-fake",
		"--session", "s.jsonl",
		"--session-dir", "/sd",
		"--name", "run",
		"--no-session",
		"--tools", "bash,read",
		"--no-builtin-tools",
		"--extension", "./e.ts",
		"--skill", "commit",
		"--skill", "review",
		"--theme", "grok",
		"--no-context-files",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rpc argv mismatch\n got: %v\nwant: %v", got, want)
	}
}

func TestNeoRuntimeOptionsToRpcArgv_ApproveOverride(t *testing.T) {
	yes := NeoRuntimeOptionsToRpcArgv(NeoRuntimeOptions{ProjectTrustOverride: boolPtr(true)})
	if !containsArg(yes, "--approve") {
		t.Fatalf("projectTrustOverride=true must emit --approve: %v", yes)
	}
	no := NeoRuntimeOptionsToRpcArgv(NeoRuntimeOptions{ProjectTrustOverride: boolPtr(false)})
	if !containsArg(no, "--no-approve") {
		t.Fatalf("projectTrustOverride=false must emit --no-approve: %v", no)
	}
}

func TestNeoRuntimeOptionsToRpcArgv_UnknownFlags(t *testing.T) {
	opts := NeoRuntimeOptions{UnknownFlags: map[string]any{"my-bool": true, "my-val": "x"}}
	got := NeoRuntimeOptionsToRpcArgv(opts)
	if !containsArg(got, "--my-bool") {
		t.Fatalf("bool extension flag missing: %v", got)
	}
	if !containsSeq(got, "--my-val", "x") {
		t.Fatalf("value extension flag missing: %v", got)
	}
}

// Connect wires the transport selection: --isolated → StdioTransport child;
// otherwise → daemon attach. This test drives the isolated branch via an injected
// stdio factory so no real node child is spawned; the daemon branch is covered by
// the AttachOrSpawn matrix.
func TestConnect_IsolatedUsesStdioFactory(t *testing.T) {
	var gotArgs []string
	fakeTransport := &nopTransport{}
	cfg := ConnectConfig{
		NeoArgv:  []string{"--isolated", "--model", "m", "--no-builtin-tools"},
		GOOS:     "linux",
		AgentDir: t.TempDir(),
		Cwd:      "/proj",
		Timeout:  time.Second,
		newStdio: func(extra []string) (Transport, error) {
			gotArgs = extra
			return fakeTransport, nil
		},
	}
	res, err := Connect(cfg)
	if err != nil {
		t.Fatalf("Connect isolated: %v", err)
	}
	if res.Mode != TransportIsolated {
		t.Fatalf("expected isolated mode, got %v", res.Mode)
	}
	if res.Transport != fakeTransport {
		t.Fatalf("expected the fake stdio transport to be returned")
	}
	// The isolated child gets the runtime argv rendered from the parsed options.
	if !containsArg(gotArgs, "--model") || !containsArg(gotArgs, "--no-builtin-tools") {
		t.Fatalf("isolated child argv missing runtime flags: %v", gotArgs)
	}
	// --isolated is launcher-local and must NOT be forwarded to the child.
	if containsArg(gotArgs, "--isolated") {
		t.Fatalf("--isolated must not reach the rpc child: %v", gotArgs)
	}
}

// nopTransport is a Transport that reads EOF and discards writes.
type nopTransport struct{}

func (n *nopTransport) Read(p []byte) (int, error)  { return 0, nil }
func (n *nopTransport) Write(p []byte) (int, error) { return len(p), nil }
func (n *nopTransport) Close() error                { return nil }

func containsArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func containsSeq(args []string, a, b string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == a && args[i+1] == b {
			return true
		}
	}
	return false
}
