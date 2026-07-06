package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// NeoDaemonProtocolVersion mirrors NEO_DAEMON_PROTOCOL_VERSION in
// packages/coding-agent/src/modes/rpc/neo-daemon-registry.ts. Bump only in
// lockstep with the TS constant.
const NeoDaemonProtocolVersion = 1

// NeoDaemonRecord is the on-disk record the daemon publishes so a client can find
// a running daemon for a cwd. It mirrors the TS NeoDaemonRecord. The client only
// ever READS this; the daemon is the sole writer (atomic temp+rename, mode 0600).
type NeoDaemonRecord struct {
	Version int    `json:"version"`
	Socket  string `json:"socket"`
	PID     int    `json:"pid"`
	Token   string `json:"token"`
}

var cwdKeyReplacer = regexp.MustCompile(`[/\\:]`)

// NeoDaemonCwdKey computes the safe registry-key for a cwd, mirroring
// neoDaemonCwdKey in neo-daemon-registry.ts: `--` + resolvedCwd with a leading
// slash/backslash stripped and every [/\:] replaced by `-`, then `--`.
//
// The caller passes an already-resolved absolute cwd; store.resolvePath is the
// Go analogue of the TS resolvePath used on the daemon side.
func NeoDaemonCwdKey(resolvedCwd string) string {
	trimmed := strings.TrimLeft(resolvedCwd, `/\`)
	replaced := cwdKeyReplacer.ReplaceAllString(trimmed, "-")
	return "--" + replaced + "--"
}

// NeoDaemonRegistryDir is the directory holding all neo daemon registry records.
func NeoDaemonRegistryDir(agentDir string) string {
	return filepath.Join(agentDir, "neo-daemon")
}

// NeoDaemonRegistryPath is the absolute path to the registry record for a cwd.
func NeoDaemonRegistryPath(agentDir, resolvedCwd string) string {
	return filepath.Join(NeoDaemonRegistryDir(agentDir), NeoDaemonCwdKey(resolvedCwd)+".json")
}

// ReadNeoDaemonRecord reads the registry record for a cwd. It returns (nil, nil)
// when the file is missing, unreadable, malformed, or missing a required field —
// all non-fatal, mirroring readNeoDaemonRecord in the TS: the caller then spawns
// (or, for a corrupt file, repairs+respawns).
func ReadNeoDaemonRecord(agentDir, resolvedCwd string) (*NeoDaemonRecord, error) {
	path := NeoDaemonRegistryPath(agentDir, resolvedCwd)
	raw, err := os.ReadFile(path)
	if err != nil {
		// Missing / unreadable is non-fatal.
		return nil, nil
	}
	var rec NeoDaemonRecord
	if uerr := json.Unmarshal(raw, &rec); uerr != nil {
		return nil, nil
	}
	if !validRecord(rec) {
		return nil, nil
	}
	return &rec, nil
}

// validRecord mirrors isValidRecord: socket/token must be present. version/pid
// are numbers in the TS check; a genuinely absent socket or token (JSON
// zero-value "") is what marks a record malformed here. pid==0 is left to
// staleness detection (IsPidAlive(0) is false), matching the TS which accepts any
// numeric pid and lets liveness sort it out.
func validRecord(r NeoDaemonRecord) bool {
	return r.Socket != "" && r.Token != ""
}

// neoDaemonRegistryPathForTest is a test-visible alias so tests can address the
// same path without re-deriving the key.
func neoDaemonRegistryPathForTest(agentDir, resolvedCwd string) string {
	return NeoDaemonRegistryPath(agentDir, resolvedCwd)
}

// marshalRecordForTest renders a record exactly as the daemon would (indented
// JSON), used by the test daemon stand-in.
func marshalRecordForTest(t interface{ Fatal(...any) }, rec NeoDaemonRecord) []byte {
	b, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return b
}
