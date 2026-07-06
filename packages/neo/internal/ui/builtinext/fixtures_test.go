package builtinext

import (
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// initTestTheme is a no-op hook kept for parity with the TS suites'
// beforeAll(() => initTheme("dark")); neo threads the theme explicitly through
// options, so there is no global theme to initialize. It exists so ported tests
// read identically to their source.
func initTestTheme(t *testing.T) { t.Helper() }

// testThemeOrNil returns a real grok-night theme for transcript rendering.
func testThemeOrNil(t *testing.T) *theme.Theme { return testTheme(t) }

// visibleWidthTest returns the terminal cell width of s (ANSI-aware).
func visibleWidthTest(s string) int { return ui.VisibleWidth(s) }

// This file holds JSONL-fixture builders shared across the builtinext test
// suites. They mirror the TS helpers in
// packages/coding-agent/test/suite/history-search-fixtures.ts so the Go table
// tests exercise byte-identical session-file shapes.

func isoTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

func stripANSI(s string) string { return ui.StripANSI(s) }

// sessionLine builds a `type:"session"` header line.
func sessionLine(id, cwd string, ts int64) string {
	b, _ := json.Marshal(map[string]any{
		"type":      "session",
		"id":        id,
		"timestamp": isoTime(ts),
		"cwd":       cwd,
	})
	return string(b)
}

// userLine builds a `type:"message"` user line with array text content parts.
func userLine(textParts []string, ts int64) string {
	content := make([]map[string]string, len(textParts))
	for i, p := range textParts {
		content[i] = map[string]string{"type": "text", "text": p}
	}
	b, _ := json.Marshal(map[string]any{
		"type":      "message",
		"id":        "msg-" + strconv.FormatInt(ts, 10),
		"parentId":  "parent",
		"timestamp": isoTime(ts),
		"message":   map[string]any{"role": "user", "content": content},
	})
	return string(b)
}

// messageLine builds a generic `type:"message"` entry with an arbitrary payload.
func messageLine(id string, ts int64, message any) string {
	b, _ := json.Marshal(map[string]any{
		"type":      "message",
		"id":        id,
		"parentId":  "parent",
		"timestamp": isoTime(ts),
		"message":   message,
	})
	return string(b)
}

// modelChangeLine builds a `type:"model_change"` entry.
func modelChangeLine(ts int64) string {
	b, _ := json.Marshal(map[string]any{
		"type":      "model_change",
		"id":        "model-change",
		"parentId":  "parent",
		"timestamp": isoTime(ts),
		"provider":  "openai",
		"modelId":   "gpt-5",
	})
	return string(b)
}
