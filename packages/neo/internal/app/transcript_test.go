package app_test

// Translator contract (todo 3): every EventMsg the session adapter demuxes is
// mapped into transcript Feed.Apply calls (or explicitly ignored/deferred) —
// never dropped silently. Includes the bridge.KnownEventTypes exhaustiveness
// sub-test and the 500-delta streaming perf test.
//
// RED first: app.NewTranscript and the disposition constants do not exist
// until GREEN.

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript"
)

// newTranscriptFixture builds a Feed + translator pair on the default theme and
// pure-default keybindings, with the log sink silenced (tests that assert on
// logging install their own via SetLogf).
func newTranscriptFixture(t *testing.T) (*transcript.Feed, *app.Transcript) {
	t.Helper()
	feed := transcript.NewFeed(transcript.DefaultRenderTheme())
	tr := app.NewTranscript(feed, keybindings.NewManager(nil))
	tr.SetLogf(func(string, ...any) {})
	return feed, tr
}

// eventMsg decodes a raw stream line exactly the way the session adapter does
// (DecodeMessage → AsEvent), so the translator sees real bridge.Event payloads.
func eventMsg(t *testing.T, line string) app.EventMsg {
	t.Helper()
	msg, err := bridge.DecodeMessage([]byte(line))
	if err != nil {
		t.Fatalf("decode %q: %v", line, err)
	}
	ev, err := msg.AsEvent()
	if err != nil {
		t.Fatalf("as event %q: %v", line, err)
	}
	return app.EventMsg{Event: ev}
}

func feedText(feed *transcript.Feed) string {
	return strings.Join(feed.Render(100), "\n")
}

// rawForKeyID converts a resolved keybinding id (e.g. "ctrl+o") into the raw
// terminal bytes the Manager matches on. Only ctrl+<letter> and bare printable
// ids are needed here; anything else fails the test so the helper never guesses.
func rawForKeyID(t *testing.T, keyID string) string {
	t.Helper()
	if rest, ok := strings.CutPrefix(keyID, "ctrl+"); ok && len(rest) == 1 && rest[0] >= 'a' && rest[0] <= 'z' {
		return string(rest[0] - 'a' + 1)
	}
	if len(keyID) == 1 {
		return keyID
	}
	t.Fatalf("rawForKeyID: unsupported key id %q", keyID)
	return ""
}

func TestTranscriptMessageStreamRendersToFeed(t *testing.T) {
	feed, tr := newTranscriptFixture(t)

	for _, line := range []string{
		`{"type":"message_start","message":{"role":"assistant","content":[]}}`,
		`{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"stream alpha"}]}}`,
		`{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"stream alpha beta"}]}}`,
	} {
		if d := tr.HandleEvent(eventMsg(t, line)); d != app.EventApplied {
			t.Fatalf("event %q: want EventApplied, got %v", line, d)
		}
	}
	joined := feedText(feed)
	if !strings.Contains(joined, "stream alpha beta") {
		t.Fatalf("streamed content missing: %q", joined)
	}
	if got := strings.Count(joined, "stream alpha"); got != 1 {
		t.Fatalf("in-place update duplicated content: %d occurrences in %q", got, joined)
	}

	tr.HandleEvent(eventMsg(t, `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"stream alpha beta gamma"}]}}`))
	joined = feedText(feed)
	if !strings.Contains(joined, "stream alpha beta gamma") {
		t.Fatalf("finalized content missing: %q", joined)
	}
	if got := strings.Count(joined, "stream alpha"); got != 1 {
		t.Fatalf("message_end appended instead of finalizing: %d occurrences in %q", got, joined)
	}
}

func TestTranscriptUserMessageRendersOnce(t *testing.T) {
	feed, tr := newTranscriptFixture(t)
	tr.HandleEvent(eventMsg(t, `{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"please run the suite"}]}}`))
	tr.HandleEvent(eventMsg(t, `{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"please run the suite"}]}}`))
	if got := strings.Count(feedText(feed), "please run the suite"); got != 1 {
		t.Fatalf("user message rendered %d times, want 1", got)
	}
}

func TestTranscriptToolLifecycle(t *testing.T) {
	feed, tr := newTranscriptFixture(t)

	tr.HandleEvent(eventMsg(t, `{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls -la"}}`))
	joined := feedText(feed)
	if !strings.Contains(joined, "◆") || !strings.Contains(joined, "ls -la") {
		t.Fatalf("tool start row missing: %q", joined)
	}

	// Wire shape: args + partialResult on tool_execution_update.
	tr.HandleEvent(eventMsg(t, `{"type":"tool_execution_update","toolCallId":"c1","toolName":"bash","args":{"command":"ls -la"},"partialResult":{"content":[{"type":"text","text":"partial-line-1"}]}}`))
	if joined := feedText(feed); !strings.Contains(joined, "partial-line-1") {
		t.Fatalf("partial output not streamed: %q", joined)
	}

	// Wire shape: result object + TOP-LEVEL isError on tool_execution_end.
	tr.HandleEvent(eventMsg(t, `{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"content":[{"type":"text","text":"final-output"}]},"isError":false}`))
	joined = feedText(feed)
	if !strings.Contains(joined, "final-output") {
		t.Fatalf("final result missing: %q", joined)
	}
	if strings.Contains(joined, "partial-line-1") {
		t.Fatalf("partial output survived finalization: %q", joined)
	}
}

func TestTranscriptToolHookStatusCounts(t *testing.T) {
	feed, tr := newTranscriptFixture(t)
	tr.HandleEvent(eventMsg(t, `{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}`))
	tr.HandleEvent(eventMsg(t, `{"type":"tool_hook_status","toolCallId":"c1","phase":"start","hookRunId":"h1","hookName":"PreToolUse","toolName":"bash","extensionPath":"/x","statusMessage":"checking","startedAt":1}`))
	if joined := feedText(feed); !strings.Contains(joined, "[hooks: 1]") {
		t.Fatalf("active hook count missing: %q", joined)
	}
	tr.HandleEvent(eventMsg(t, `{"type":"tool_hook_status","toolCallId":"c1","phase":"end","hookRunId":"h1","hookName":"PreToolUse","toolName":"bash","extensionPath":"/x","statusMessage":"ok","startedAt":1,"completedAt":2,"status":"completed"}`))
	if joined := feedText(feed); strings.Contains(joined, "[hooks:") {
		t.Fatalf("hook count not cleared after end phase: %q", joined)
	}
}

func TestTranscriptAbortMarksPendingTools(t *testing.T) {
	feed, tr := newTranscriptFixture(t)
	tr.HandleEvent(eventMsg(t, `{"type":"message_start","message":{"role":"assistant","content":[]}}`))
	tr.HandleEvent(eventMsg(t, `{"type":"tool_execution_start","toolCallId":"c7","toolName":"bash","args":{"command":"sleep 99"}}`))

	// Aborted turn: message_end with stopReason aborted → feed.AbortPending().
	tr.HandleEvent(eventMsg(t, `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"aborted","errorMessage":"Request was aborted"}}`))
	joined := feedText(feed)
	if !strings.Contains(joined, "Operation aborted") {
		t.Fatalf("pending tool not aborted on aborted message_end: %q", joined)
	}
	for _, frame := range transcript.SpinnerFramesForTest() {
		if strings.Contains(joined, frame) {
			t.Fatalf("orphan spinner frame %q after abort", frame)
		}
	}

	// agent_end is the safety net for stragglers and must be handled.
	if d := tr.HandleEvent(eventMsg(t, `{"type":"agent_end","messages":[]}`)); d != app.EventApplied {
		t.Fatalf("agent_end: want EventApplied, got %v", d)
	}
}

func TestTranscriptSummariesAndCustomMessages(t *testing.T) {
	feed, tr := newTranscriptFixture(t)

	tr.HandleEvent(eventMsg(t, `{"type":"compaction_end","reason":"manual","aborted":false,"willRetry":false,"result":{"summary":"squeezed the transcript","tokensBefore":12345}}`))
	tr.HandleEvent(eventMsg(t, `{"type":"message_end","message":{"role":"branchSummary","summary":"took the left fork","fromId":"e1"}}`))
	tr.HandleEvent(eventMsg(t, `{"type":"message_start","message":{"role":"custom","customType":"memo","display":true,"content":"remember the milk"}}`))
	tr.HandleEvent(eventMsg(t, `{"type":"message_start","message":{"role":"custom","customType":"hidden","display":false,"content":"invisible-note"}}`))

	joined := feedText(feed)
	if !strings.Contains(joined, "[compaction]") || !strings.Contains(joined, "12,345") {
		t.Fatalf("compaction summary missing: %q", joined)
	}
	if !strings.Contains(joined, "[branch]") {
		t.Fatalf("branch summary missing: %q", joined)
	}
	if !strings.Contains(joined, "[memo]") || !strings.Contains(joined, "remember the milk") {
		t.Fatalf("custom message missing: %q", joined)
	}
	if strings.Contains(joined, "invisible-note") {
		t.Fatalf("display=false custom message rendered: %q", joined)
	}

	// A cancelled compaction adds nothing to the transcript.
	tr.HandleEvent(eventMsg(t, `{"type":"compaction_end","reason":"manual","aborted":true,"willRetry":false}`))
	if got := strings.Count(feedText(feed), "[compaction]"); got != 1 {
		t.Fatalf("aborted compaction_end changed the feed: %d compaction entries", got)
	}
}

func TestTranscriptExpandAndThinkingKeysViaManager(t *testing.T) {
	feed, _ := newTranscriptFixture(t)
	keys := keybindings.NewManager(nil)
	tr := app.NewTranscript(feed, keys)

	tr.HandleEvent(eventMsg(t, `{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"many"}}`))
	var lines []string
	for i := 0; i < 15; i++ {
		lines = append(lines, fmt.Sprintf("out-line-%d", i))
	}
	tr.HandleEvent(eventMsg(t, fmt.Sprintf(
		`{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"content":[{"type":"text","text":%q}]},"isError":false}`,
		strings.Join(lines, "\n"))))
	if joined := feedText(feed); !strings.Contains(joined, "out-line-14") {
		t.Fatalf("tool output missing: %q", joined)
	}

	expandKeys := keys.Keys("app.tools.expand")
	if len(expandKeys) == 0 {
		t.Fatalf("app.tools.expand unbound")
	}
	raw := rawForKeyID(t, expandKeys[0])
	if !tr.HandleKey(raw) {
		t.Fatalf("expand key %q not consumed", expandKeys[0])
	}
	if joined := feedText(feed); !strings.Contains(joined, "out-line-0") {
		t.Fatalf("expand toggle did not expand tool output: %q", joined)
	}

	tr.HandleEvent(eventMsg(t, `{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"pondering deeply"},{"type":"text","text":"answer"}]}}`))
	thinkKeys := keys.Keys("app.thinking.toggle")
	if len(thinkKeys) == 0 {
		t.Fatalf("app.thinking.toggle unbound")
	}
	if !tr.HandleKey(rawForKeyID(t, thinkKeys[0])) {
		t.Fatalf("thinking key %q not consumed", thinkKeys[0])
	}
	joined := feedText(feed)
	if strings.Contains(joined, "pondering deeply") || !strings.Contains(joined, "Thinking...") {
		t.Fatalf("thinking toggle did not hide the block: %q", joined)
	}

	// A key bound to neither action is not consumed.
	if tr.HandleKey("\x00ulw-not-a-key") {
		t.Fatalf("unrelated key consumed by transcript toggles")
	}
}

// TestTranscriptExhaustiveEventCoverage: every bridge.KnownEventTypes() key is
// either handled (applied/deferred) or in the translator's explicit ignore-list;
// none falls through to the unknown path.
func TestTranscriptExhaustiveEventCoverage(t *testing.T) {
	_, tr := newTranscriptFixture(t)
	for typ := range bridge.KnownEventTypes() {
		typ := typ
		t.Run(typ, func(t *testing.T) {
			d := tr.HandleEvent(eventMsg(t, fmt.Sprintf(`{"type":%q}`, typ)))
			if d == app.EventUnknown {
				t.Fatalf("known event type %q fell through to the unknown path", typ)
			}
		})
	}
}

func TestTranscriptUnknownEventLoggedOnce(t *testing.T) {
	_, tr := newTranscriptFixture(t)
	var logs []string
	tr.SetLogf(func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	})

	first := tr.HandleEvent(eventMsg(t, `{"type":"ulw_never_heard_of_it"}`))
	second := tr.HandleEvent(eventMsg(t, `{"type":"ulw_never_heard_of_it"}`))
	if first != app.EventUnknown || second != app.EventUnknown {
		t.Fatalf("unknown type dispositions: %v, %v", first, second)
	}
	if len(logs) != 1 {
		t.Fatalf("unknown type must be logged exactly once, got %d logs: %v", len(logs), logs)
	}
	if !strings.Contains(logs[0], "ulw_never_heard_of_it") {
		t.Fatalf("log line does not name the unknown type: %q", logs[0])
	}
}

// TestTranscriptStreamingPerf500Deltas drives 500 synthetic message_update
// deltas through the translator (rendering the frame after every delta) and
// asserts total processing stays under 2s with no goroutine leak (delta ≤2).
func TestTranscriptStreamingPerf500Deltas(t *testing.T) {
	feed, tr := newTranscriptFixture(t)
	before := runtime.NumGoroutine()

	tr.HandleEvent(eventMsg(t, `{"type":"message_start","message":{"role":"assistant","content":[]}}`))

	var text strings.Builder
	start := time.Now()
	for i := 0; i < 500; i++ {
		fmt.Fprintf(&text, "delta-%03d ", i)
		line := fmt.Sprintf(`{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":%q}]}}`, text.String())
		if d := tr.HandleEvent(eventMsg(t, line)); d != app.EventApplied {
			t.Fatalf("delta %d: want EventApplied, got %v", i, d)
		}
		feed.Render(100)
	}
	elapsed := time.Since(start)
	if elapsed >= 2*time.Second {
		t.Fatalf("500 message_update deltas took %v (budget 2s)", elapsed)
	}

	tr.HandleEvent(eventMsg(t, fmt.Sprintf(
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%q}]}}`, text.String())))
	if joined := feedText(feed); !strings.Contains(joined, "delta-499") {
		t.Fatalf("final delta missing from render")
	}

	after := runtime.NumGoroutine()
	if after-before > 2 {
		t.Fatalf("goroutine leak: before %d, after %d", before, after)
	}
}
