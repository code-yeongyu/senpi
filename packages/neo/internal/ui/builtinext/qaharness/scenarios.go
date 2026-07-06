package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/builtinext"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

const baseTime int64 = 1_779_019_200_000 // 2026-05-20T12:00:00.000Z

func iso(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z07:00") }

func sessionLine(id, cwd string, ts int64) string {
	b, _ := json.Marshal(map[string]any{"type": "session", "id": id, "timestamp": iso(ts), "cwd": cwd})
	return string(b)
}

func userLine(text string, ts int64) string {
	b, _ := json.Marshal(map[string]any{
		"type": "message", "id": "u-" + strconv.FormatInt(ts, 10), "parentId": "p", "timestamp": iso(ts),
		"message": map[string]any{"role": "user", "content": []map[string]string{{"type": "text", "text": text}}},
	})
	return string(b)
}

func assistantLine(text string, ts int64) string {
	b, _ := json.Marshal(map[string]any{
		"type": "message", "id": "a-" + strconv.FormatInt(ts, 10), "parentId": "p", "timestamp": iso(ts),
		"message": map[string]any{
			"role": "assistant", "model": "gpt-5",
			"content": []any{map[string]any{"type": "text", "text": text}},
		},
	})
	return string(b)
}

// seedTwoSessions writes two fixture session files under a temp sessions root and
// returns the root. Prompts are seeded so history search finds matches across
// BOTH sessions (the happy scenario).
func seedTwoSessions() (string, error) {
	root, err := os.MkdirTemp("", "t14-history-")
	if err != nil {
		return "", err
	}
	dirA := filepath.Join(root, "--repo-alpha--")
	dirB := filepath.Join(root, "--repo-beta--")
	for _, d := range []string{dirA, dirB} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return "", err
		}
	}
	sessionA := strings.Join([]string{
		sessionLine("alpha-session", "/repo/alpha", baseTime),
		userLine("deploy production release", baseTime+1_000),
		userLine("run the migration script", baseTime+2_000),
	}, "\n")
	sessionB := strings.Join([]string{
		sessionLine("beta-session", "/repo/beta", baseTime+10_000),
		userLine("deploy staging preview", baseTime+11_000),
		userLine("rollback the last deploy", baseTime+12_000),
	}, "\n")
	if err := os.WriteFile(filepath.Join(dirA, "20260520_alpha-session.jsonl"), []byte(sessionA+"\n"), 0o644); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dirB, "20260520_beta-session.jsonl"), []byte(sessionB+"\n"), 0o644); err != nil {
		return "", err
	}
	return root, nil
}

func runHistory(th *theme.Theme, km *keybindings.Manager, width int, query string) {
	root, err := seedTwoSessions()
	if err != nil {
		fmt.Fprintln(os.Stderr, "seed failed:", err)
		os.Exit(1)
	}
	defer func() { _ = os.RemoveAll(root) }()

	entries, err := builtinext.IndexSessions(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "index failed:", err)
		os.Exit(1)
	}
	ov := builtinext.NewHistorySearchOverlay(builtinext.HistorySearchOptions{
		Entries: entries, Theme: th, Keybindings: km,
		RequestRender: func() {}, Done: func(builtinext.HistoryEntry, bool) {},
	})
	ov.SetFocused(true)
	for _, r := range query {
		ov.HandleInput(string(r))
	}
	// Report the cross-session match count on stderr so the QA log proves the
	// happy scenario finds seeded history across BOTH fixture sessions.
	fmt.Fprintf(os.Stderr, "history: %d prompts indexed across 2 sessions; %d match query %q\n",
		len(entries), len(ov.FilteredEntries()), query)
	emit(ov.Render(width))
}

func runObserver(th *theme.Theme, km *keybindings.Manager, width int) {
	root, err := os.MkdirTemp("", "t14-observer-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "tmp failed:", err)
		os.Exit(1)
	}
	defer func() { _ = os.RemoveAll(root) }()
	dir := filepath.Join(root, "--repo-live--")
	_ = os.MkdirAll(dir, 0o755)
	file := filepath.Join(dir, "20260520_live-session.jsonl")

	// Initial content: header + one user prompt.
	_ = os.WriteFile(file, []byte(strings.Join([]string{
		sessionLine("live-session", "/repo/live", baseTime),
		userLine("start the live run", baseTime+1_000),
	}, "\n")+"\n"), 0o644)

	tail := builtinext.NewSessionTail(file)
	snap, err := tail.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "load failed:", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "observer: initial entries=%d\n", len(snap.Entries))

	// Simulate the file GROWING as a live session appends (the failure scenario:
	// tail behavior, no crash).
	f, _ := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o644)
	for i := 1; i <= 3; i++ {
		ts := baseTime + int64(1_000+i*1_000)
		_, _ = f.WriteString(assistantLine(fmt.Sprintf("progress step %d", i), ts) + "\n")
	}
	_ = f.Close()

	snap2, err := tail.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "reload after growth failed:", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "observer: after growth entries=%d grew=%v (no crash)\n", len(snap2.Entries), tail.Grew())

	// Render the HUD viewer over the grown session so the frame proves the tailed
	// transcript renders the appended entries.
	sessions, _ := builtinext.ScanSessionHudEntries(root, file)
	ov := builtinext.NewSessionHudOverlay(builtinext.SessionHudOptions{
		Sessions: sessions, Theme: th, Keybindings: km,
		Done: func() {}, RequestRender: func() {},
	})
	ov.HandleInput("\r") // open the viewer on the (only) session
	ov.Refresh(width)
	emit(ov.Render(width))
}

func runFiles(th *theme.Theme, km *keybindings.Manager, width int) {
	files := []builtinext.FileEntry{
		{Path: "src/server.go", Operations: map[string]bool{"read": true, "edit": true}, LastTimestamp: baseTime + 3_000},
		{Path: "src/config.go", Operations: map[string]bool{"write": true}, LastTimestamp: baseTime + 2_000},
		{Path: "README.md", Operations: map[string]bool{"read": true}, LastTimestamp: baseTime + 1_000},
	}
	ov := builtinext.NewFilesPickerOverlay(builtinext.FilesPickerOptions{
		Files: files, Theme: th, Keybindings: km,
		OnOpen: func(builtinext.FileEntry) {}, Done: func() {}, RequestRender: func() {},
	})
	emit(ov.Render(width))
}

func runDiff(th *theme.Theme, km *keybindings.Manager, width int) {
	status := " M src/server.go\nA  src/new-feature.go\n D src/legacy.go\n?? scratch.txt"
	files := builtinext.ParseGitStatus(status)
	ov := builtinext.NewDiffPickerOverlay(builtinext.DiffPickerOptions{
		Files: files, Theme: th, Keybindings: km,
		OnOpen: func(builtinext.FileDiffInfo) {}, Done: func() {}, RequestRender: func() {},
	})
	emit(ov.Render(width))
}

func runRedraws() {
	c := &builtinext.RedrawCounter{}
	for i := 0; i < 7; i++ {
		c.RecordFullRedraw()
	}
	msg, level := builtinext.RedrawsNotice(c.FullRedraws())
	fmt.Printf("[%s] %s\r\n", level, msg)
}

func runNotice(th *theme.Theme, km *keybindings.Manager, width int) {
	// Exercise the notice from an additive custom_unsupported request, the exact
	// shape a task-13 capability-flagged host will emit.
	req := bridge.ExtensionUIRequest{
		Type: "extension_ui_request", ID: "req-1", Method: builtinext.CustomUnsupportedMethod,
		Fields: map[string]any{"extensionName": "acme-dashboard"},
	}
	ov, ok := builtinext.NoticeForRequest(req, builtinext.NoticeDeps{
		Theme: th, Keybindings: km, Done: func() {}, RequestRender: func() {},
	})
	if !ok {
		fmt.Fprintln(os.Stderr, "notice: request did not route to dialog")
		os.Exit(1)
	}
	emit(ov.Render(width))
}
