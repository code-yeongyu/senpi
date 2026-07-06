package bridge

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"
)

// tsUnions mirrors the JSON emitted by testdata/extract-ts-union.mjs, which
// parses the ACTUAL TypeScript sources (rpc-types.ts, agent-session.ts,
// packages/agent types.ts, extension event types, rpc-mode.ts) at test time.
// Hand-maintained lists are explicitly disallowed by the plan; the source of
// truth is the TS parse.
type tsUnions struct {
	Commands           []string `json:"commands"`
	ResponseCommands   []string `json:"responseCommands"`
	ExtensionUIMethods []string `json:"extensionUIMethods"`
	Events             []string `json:"events"`
}

// extractTSUnions runs the Node extractor and returns the parsed discriminant
// sets. It fails the test (skips only if node is entirely unavailable) so a
// drift in the TS protocol surfaces here.
func extractTSUnions(t *testing.T) tsUnions {
	t.Helper()
	script := filepath.Join("testdata", "extract-ts-union.mjs")
	out, err := exec.Command("node", script).Output()
	if err != nil {
		if ee, ok := err.(*exec.Error); ok && ee.Err == exec.ErrNotFound {
			t.Skip("node not found; exhaustiveness test requires the TS extractor")
		}
		t.Fatalf("run extractor: %v\noutput: %s", err, out)
	}
	var u tsUnions
	if err := json.Unmarshal(out, &u); err != nil {
		t.Fatalf("parse extractor output: %v\n%s", err, out)
	}
	return u
}

func assertCovered(t *testing.T, kind string, want []string, have map[string]bool) {
	t.Helper()
	var missing []string
	for _, m := range want {
		if !have[m] {
			missing = append(missing, m)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("%s: %d TS member(s) have no Go variant: %v", kind, len(missing), missing)
	}
}

// TestExhaustiveCommands asserts a Go RpcCommand variant exists for every
// RpcCommand.type literal in rpc-types.ts.
func TestExhaustiveCommands(t *testing.T) {
	u := extractTSUnions(t)
	assertCovered(t, "commands", u.Commands, KnownCommandTypes())
}

// TestExhaustiveResponseCommands asserts a Go response variant exists for every
// RpcResponse.command literal in rpc-types.ts.
func TestExhaustiveResponseCommands(t *testing.T) {
	u := extractTSUnions(t)
	assertCovered(t, "responseCommands", u.ResponseCommands, KnownResponseCommands())
}

// TestExhaustiveExtensionUIMethods asserts a Go variant exists for each of the
// 10 RpcExtensionUIRequest.method literals: the 9 renderable-inline methods plus
// the additive custom_unsupported notice (task 13/14).
func TestExhaustiveExtensionUIMethods(t *testing.T) {
	u := extractTSUnions(t)
	if len(u.ExtensionUIMethods) != 10 {
		t.Fatalf("expected 10 extension-UI methods from TS, got %d: %v", len(u.ExtensionUIMethods), u.ExtensionUIMethods)
	}
	assertCovered(t, "extensionUIMethods", u.ExtensionUIMethods, KnownExtensionUIMethods())
}

// TestExhaustiveEvents asserts a Go event variant exists for every member of the
// AgentSessionEvent union (base AgentEvent + session extensions) plus
// extension_error — the ACTUAL RPC stream union.
func TestExhaustiveEvents(t *testing.T) {
	u := extractTSUnions(t)
	assertCovered(t, "events", u.Events, KnownEventTypes())
}
