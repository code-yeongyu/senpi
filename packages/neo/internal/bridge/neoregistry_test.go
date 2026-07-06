package bridge

import (
	"os"
	"path/filepath"
	"testing"
)

// The registry reader is the client's read-only view of the daemon record the
// daemon writes (packages/coding-agent/src/modes/rpc/neo-daemon-registry.ts).
// Clients NEVER write it. These cases mirror the TS read path + cwd-key scheme.

func TestNeoDaemonCwdKey_MirrorsTS(t *testing.T) {
	// neoDaemonCwdKey: `--` + resolvedCwd with leading slash stripped and
	// [/\:] replaced by `-`, then `--`.
	cases := map[string]string{
		"/Users/me/proj": "--Users-me-proj--",
		"/a/b":           "--a-b--",
	}
	for cwd, want := range cases {
		if got := NeoDaemonCwdKey(cwd); got != want {
			t.Fatalf("NeoDaemonCwdKey(%q) = %q, want %q", cwd, got, want)
		}
	}
}

func TestReadNeoDaemonRecord_HappyRoundTrip(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/Users/me/proj"
	rec := NeoDaemonRecord{Version: 1, Socket: "/tmp/neo.sock", PID: os.Getpid(), Token: "tok-abc"}
	writeTestRecord(t, agentDir, cwd, rec)

	got, err := ReadNeoDaemonRecord(agentDir, cwd)
	if err != nil {
		t.Fatalf("ReadNeoDaemonRecord: %v", err)
	}
	if got == nil {
		t.Fatalf("expected a record, got nil")
	}
	if got.Version != 1 || got.Socket != "/tmp/neo.sock" || got.PID != os.Getpid() || got.Token != "tok-abc" {
		t.Fatalf("record mismatch: %+v", got)
	}
}

func TestReadNeoDaemonRecord_MissingReturnsNil(t *testing.T) {
	agentDir := t.TempDir()
	got, err := ReadNeoDaemonRecord(agentDir, "/no/such/cwd")
	if err != nil {
		t.Fatalf("missing record must be non-fatal, got err: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil for missing record, got %+v", got)
	}
}

func TestReadNeoDaemonRecord_CorruptReturnsNil(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/Users/me/proj"
	path := neoDaemonRegistryPathForTest(agentDir, cwd)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{ this is not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadNeoDaemonRecord(agentDir, cwd)
	if err != nil {
		t.Fatalf("corrupt record must be non-fatal (caller repairs+respawns), got err: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil for corrupt record, got %+v", got)
	}
}

func TestReadNeoDaemonRecord_MissingFieldReturnsNil(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/Users/me/proj"
	path := neoDaemonRegistryPathForTest(agentDir, cwd)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	// Missing token: not a valid record.
	if err := os.WriteFile(path, []byte(`{"version":1,"socket":"/tmp/s","pid":5}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadNeoDaemonRecord(agentDir, cwd)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil for record missing token, got %+v", got)
	}
}

func TestIsPidAlive(t *testing.T) {
	if !IsPidAlive(os.Getpid()) {
		t.Fatalf("current pid must be alive")
	}
	if IsPidAlive(0) || IsPidAlive(-1) {
		t.Fatalf("non-positive pid must be dead")
	}
	// A very high pid is almost certainly not a running process.
	if IsPidAlive(4_000_000_000) {
		t.Fatalf("implausibly-high pid should be reported dead")
	}
}

// writeTestRecord writes a record the way the daemon would (the client never
// writes; this helper stands in for the daemon in tests).
func writeTestRecord(t *testing.T, agentDir, cwd string, rec NeoDaemonRecord) {
	t.Helper()
	path := neoDaemonRegistryPathForTest(agentDir, cwd)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	b := marshalRecordForTest(t, rec)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}
