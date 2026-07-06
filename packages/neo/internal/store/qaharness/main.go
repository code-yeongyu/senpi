// Command qaharness is the manual-QA driver for the native ~/.senpi store
// readers (plan task 4). It runs the verbatim scenario:
//
//	happy   - point the store at a SANDBOX COPY of a real sessions tree and
//	          assert the picker data matches `ls`-derived ground truth.
//	failure - point the store at a MISSING agent dir and assert clean defaults
//	          with no crash.
//
// Isolation: the store is exercised only against a temp sandbox agent dir; the
// harness also hashes the real ~/.senpi/agent/auth.json before and after to
// prove the real credential store is untouched. It is NOT a package test; it is
// invoked by hand during QA and writes a machine-checkable report to stdout.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

func main() {
	realSrc := flagArg("--real-sessions")
	sandboxCwd := flagArg("--cwd")
	if realSrc == "" || sandboxCwd == "" {
		fmt.Fprintln(os.Stderr, "usage: qaharness --real-sessions <dir> --cwd <cwd-key>")
		os.Exit(2)
	}

	home, _ := os.UserHomeDir()
	realAuthPath := filepath.Join(home, ".senpi", "agent", "auth.json")
	beforeHash := hashFileOrAbsent(realAuthPath)
	fmt.Printf("ISOLATION real auth.json before: %s\n", beforeHash)

	sandbox, err := os.MkdirTemp("", "neo-store-qa-")
	must(err)
	fmt.Printf("SANDBOX agent dir: %s\n", sandbox)

	// Copy the real sessions dir into the sandbox under the SAME safe-path name
	// the store computes for --cwd, so ScanSessions finds it.
	safeName := store.SessionDirNameForCwd(sandboxCwd)
	dstDir := filepath.Join(sandbox, "sessions", safeName)
	must(os.MkdirAll(dstDir, 0o755))
	copied := copyJSONL(realSrc, dstDir)
	fmt.Printf("SANDBOX copied %d .jsonl files into %s\n", copied, dstDir)

	// Ground truth from `ls`: the set of .jsonl basenames in the sandbox dir.
	lsNames := lsJSONL(dstDir)
	fmt.Printf("GROUND-TRUTH ls .jsonl count: %d\n", len(lsNames))

	// ---- HAPPY PATH ----
	sessions, err := store.ScanSessions(sandbox, sandboxCwd)
	must(err)
	fmt.Printf("HAPPY ScanSessions returned %d sessions\n", len(sessions))

	// Every scanned session's file basename must be in the ls ground-truth set,
	// and the counts must match (1:1 coverage). Header-less/empty files that the
	// classic loader also drops are reconciled below.
	scannedNames := map[string]store.SessionInfo{}
	for _, s := range sessions {
		scannedNames[filepath.Base(s.Path)] = s
	}

	missingFromScan := []string{}
	for name := range lsNames {
		if _, ok := scannedNames[name]; !ok {
			missingFromScan = append(missingFromScan, name)
		}
	}
	sort.Strings(missingFromScan)

	extraInScan := []string{}
	for name := range scannedNames {
		if _, ok := lsNames[name]; !ok {
			extraInScan = append(extraInScan, name)
		}
	}
	sort.Strings(extraInScan)

	// Reconcile: any ls file the scan dropped must be a file the classic loader
	// would also drop (no valid session header). Verify that directly.
	unexplainedDrops := []string{}
	for _, name := range missingFromScan {
		if hasValidHeader(filepath.Join(dstDir, name)) {
			unexplainedDrops = append(unexplainedDrops, name)
		}
	}

	fmt.Printf("HAPPY scanned==ls? extraInScan=%d unexplainedDrops=%d (explainedDrops=%d)\n",
		len(extraInScan), len(unexplainedDrops), len(missingFromScan)-len(unexplainedDrops))

	// Print a few picker rows so a human can eyeball id/name/first-message/count.
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].Modified.After(sessions[j].Modified) })
	shown := 0
	for _, s := range sessions {
		if shown >= 5 {
			break
		}
		fmt.Printf("PICKER id=%s count=%d modified=%s first=%q\n",
			s.ID, s.MessageCount, s.Modified.Format("2006-01-02T15:04:05Z"), truncate(s.FirstMessage, 48))
		shown++
	}

	happyOK := len(extraInScan) == 0 && len(unexplainedDrops) == 0 && len(sessions) > 0

	// ---- FAILURE PATH ----
	missingAgentDir := filepath.Join(sandbox, "does-not-exist-agent")
	failSessions, ferr := store.ScanSessions(missingAgentDir, "/no/such/cwd")
	failSettings, serr := store.LoadSettings("/no/such/cwd", missingAgentDir)
	failAuth, aerr := store.LoadAuth(missingAgentDir)
	failKb, kerr := store.LoadKeybindings(missingAgentDir)
	failModels, merr := store.LoadModelsConfig(missingAgentDir)
	failThemes, therr := store.ListCustomThemes(missingAgentDir)

	failureOK := ferr == nil && len(failSessions) == 0 &&
		serr == nil && failSettings.EffectiveNeoTheme() == "" &&
		aerr == nil && len(failAuth.Providers) == 0 &&
		kerr == nil && len(failKb.Bindings) == 0 &&
		merr == nil && len(failModels.Providers) == 0 &&
		therr == nil && len(failThemes) == 0

	fmt.Printf("FAILURE missing-agent-dir clean defaults: sessions=%d settings=%q auth=%d kb=%d models=%d themes=%d errs=[%v %v %v %v %v %v]\n",
		len(failSessions), failSettings.EffectiveNeoTheme(), len(failAuth.Providers), len(failKb.Bindings),
		len(failModels.Providers), len(failThemes), ferr, serr, aerr, kerr, merr, therr)

	// ---- ISOLATION RECHECK ----
	afterHash := hashFileOrAbsent(realAuthPath)
	fmt.Printf("ISOLATION real auth.json after:  %s\n", afterHash)
	isolationOK := beforeHash == afterHash

	// Cleanup the sandbox.
	if err := os.RemoveAll(sandbox); err != nil {
		fmt.Printf("CLEANUP WARN: %v\n", err)
	} else {
		fmt.Printf("CLEANUP removed sandbox %s\n", sandbox)
	}

	fmt.Printf("RESULT happy=%v failure=%v isolation=%v\n", happyOK, failureOK, isolationOK)
	if happyOK && failureOK && isolationOK {
		fmt.Println("RESULT ALL-PASS")
		return
	}
	fmt.Println("RESULT FAIL")
	os.Exit(1)
}

func flagArg(name string) string {
	for i, a := range os.Args {
		if a == name && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return ""
}

func hashFileOrAbsent(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "ABSENT"
		}
		return "ERR:" + err.Error()
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func copyJSONL(src, dst string) int {
	entries, err := os.ReadDir(src)
	must(err)
	n := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			continue
		}
		must(os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644))
		n++
	}
	return n
}

func lsJSONL(dir string) map[string]struct{} {
	out, err := exec.Command("ls", dir).Output()
	must(err)
	names := map[string]struct{}{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasSuffix(line, ".jsonl") {
			names[line] = struct{}{}
		}
	}
	return names
}

// hasValidHeader reports whether the first non-empty line is a valid session
// header (type:"session" with a string id), matching the classic loader's drop
// rule (readSessionHeader / buildSessionInfo return null otherwise).
func hasValidHeader(path string) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var h struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal([]byte(line), &h); err != nil {
			return false
		}
		return h.Type == "session" && h.ID != ""
	}
	return false
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "FATAL:", err)
		os.Exit(1)
	}
}
