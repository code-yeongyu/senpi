package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
)

// bridgeReadRecord returns the pid the current registry record points at (0 when
// absent), used by teardown to reap whatever daemon is currently registered.
func bridgeReadRecord(agentDir, cwd string) (int, error) {
	rec, err := bridge.ReadNeoDaemonRecord(agentDir, cwd)
	if err != nil || rec == nil {
		return 0, err
	}
	return rec.PID, nil
}

// repoRoot walks up from the working dir to the senpi repo root (identified by
// packages/coding-agent/src/cli.ts), mirroring the integration test's locator.
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, statErr := os.Stat(filepath.Join(dir, "packages", "coding-agent", "src", "cli.ts")); statErr == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("senpi repo root not found from %s", dir)
		}
		dir = parent
	}
}

// hashRealAuth returns a hash of the ambient real ~/.senpi/agent/auth.json (or
// ABSENT), used to prove the QA run never touched the real credential store.
func hashRealAuth() string {
	var path string
	if d := os.Getenv("SENPI_CODING_AGENT_DIR_REAL"); d != "" {
		path = filepath.Join(d, "auth.json")
	} else {
		home, err := os.UserHomeDir()
		if err != nil {
			return "ERR"
		}
		path = filepath.Join(home, ".senpi", "agent", "auth.json")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "ABSENT"
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// writeMockModelsJSON writes a models.json pointing the anthropic provider at the
// fake server origin, mirroring the task-15 auth-isolation test's mock config.
func writeMockModelsJSON(agentDir, origin string) {
	config := map[string]any{
		"providers": map[string]any{
			"anthropic": map[string]any{
				"baseUrl": origin,
				"apiKey":  "unused-placeholder",
				"api":     "anthropic-messages",
				"models": []map[string]any{
					{
						"id":            "mock-claude",
						"baseUrl":       origin,
						"api":           "anthropic-messages",
						"contextWindow": 128000,
						"maxTokens":     4096,
						"cost":          map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
					},
				},
			},
		},
	}
	b, _ := json.MarshalIndent(config, "", "  ")
	_ = os.WriteFile(filepath.Join(agentDir, "models.json"), b, 0o644)
}

// psTree returns the pid/ppid/command of every process whose command line
// mentions the sandbox agent dir, so the harness can count supervisor vs worker
// processes for THIS run only.
type procInfo struct {
	pid  int
	ppid int
	args string
}

// psSnapshot returns every senpi CLI process (identified by the marker, usually
// the cli entry path) with its pid/ppid/args. `ps -Aww` is used so the full
// command line — including the discriminating --listen / --mode rpc flags, which
// sit well past the default 200-column truncation — is visible.
func psSnapshot(marker string) []procInfo {
	out, err := exec.Command("ps", "-Aww", "-o", "pid=,ppid=,args=").Output()
	if err != nil {
		return nil
	}
	var procs []procInfo
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, marker) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		var pid, ppid int
		_, _ = fmt.Sscanf(fields[0], "%d", &pid)
		_, _ = fmt.Sscanf(fields[1], "%d", &ppid)
		procs = append(procs, procInfo{pid: pid, ppid: ppid, args: line})
	}
	return procs
}

// classifyForDaemon splits the marked processes into the ONE supervisor with the
// given pid and the rpc workers that are its children (ppid == supervisorPID).
// Restricting to this daemon's own pid tree keeps the count exact even when other
// neo daemons from earlier runs are still winding down their idle timers.
func classifyForDaemon(procs []procInfo, supervisorPID int) (supervisors, workers []procInfo) {
	for _, p := range procs {
		switch {
		case p.pid == supervisorPID && strings.Contains(p.args, "--listen"):
			supervisors = append(supervisors, p)
		case p.ppid == supervisorPID && strings.Contains(p.args, "--mode rpc"):
			workers = append(workers, p)
		}
	}
	return supervisors, workers
}
