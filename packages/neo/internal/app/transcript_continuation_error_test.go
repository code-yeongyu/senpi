package app_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
)

func TestTranscriptContinuationErrorSanitizesTerminalControls(t *testing.T) {
	// Given: a detached continuation failure emitted by AgentSession.
	feed, tr := newTranscriptFixture(t)
	hostileMessage := "Failed\x1b]52;c;c2VjcmV0\x07 to\x1b]0;stolen title\x07 continue" +
		"\x1b]8;;https://attacker.invalid\x07 queued\x1b]8;;\x07\x00 messages:\x7f" +
		"\u0085 \x1b[999mprovider\x1b[0m unavailable"
	line, err := json.Marshal(struct {
		Type         string `json:"type"`
		ErrorMessage string `json:"errorMessage"`
	}{Type: "continuation_error", ErrorMessage: hostileMessage})
	if err != nil {
		t.Fatalf("marshal continuation_error: %v", err)
	}
	msg := eventMsg(t, string(line))

	// When: Neo translates the session event into its transcript.
	disposition := tr.HandleEvent(msg)

	// Then: readable text remains while hostile terminal controls are absent.
	if disposition != app.EventApplied {
		t.Fatalf("continuation_error disposition = %v, want EventApplied", disposition)
	}
	joined := feedText(feed)
	if !strings.Contains(joined, "Failed to continue queued messages: provider unavailable") {
		t.Fatalf("continuation_error message missing from transcript: %q", joined)
	}
	for _, forbidden := range []string{
		"\x1b]52;", "\x1b]0;", "\x1b]8;", "\x1b[999m", "\x00", "\x7f", "\u0085",
		"attacker.invalid", "stolen title", "c2VjcmV0",
	} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("continuation_error render contains hostile payload %q: %q", forbidden, joined)
		}
	}
	if bells := strings.Count(joined, "\x07"); bells != 3 {
		t.Fatalf("continuation_error render bell count = %d, want 3 production OSC 133 terminators: %q", bells, joined)
	}
}

func TestTranscriptContinuationErrorMalformedPayloadsFailClosed(t *testing.T) {
	feed, tr := newTranscriptFixture(t)
	before := feedText(feed)

	for _, line := range []string{
		`{"type":"continuation_error"}`,
		`{"type":"continuation_error","errorMessage":42}`,
	} {
		if disposition := tr.HandleEvent(eventMsg(t, line)); disposition != app.EventApplied {
			t.Fatalf("malformed continuation_error disposition = %v, want EventApplied", disposition)
		}
	}
	if after := feedText(feed); after != before {
		t.Fatalf("malformed continuation_error changed transcript: before=%q after=%q", before, after)
	}

	valid := eventMsg(t, `{"type":"continuation_error","errorMessage":"subsequent valid failure"}`)
	if disposition := tr.HandleEvent(valid); disposition != app.EventApplied {
		t.Fatalf("valid continuation_error disposition = %v, want EventApplied", disposition)
	}
	if joined := feedText(feed); !strings.Contains(joined, "subsequent valid failure") {
		t.Fatalf("valid event after malformed payloads did not render: %q", joined)
	}
}
