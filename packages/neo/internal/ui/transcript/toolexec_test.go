package transcript

// Ported/derived contract for the tool-execution block. Source:
// packages/coding-agent/src/modes/interactive/components/tool-execution.ts
// (grok tool-row: guide `┃` + marker `◆`, pending→result body, collapse/expand,
// bounded render-signature caching) and grok tool-result capture rows in
// .omo/research/neo-grok/captures/. Rendering asserts against structural
// content (glyphs, cmd, [hooks: N], output) rather than exact SGR here; the
// exact-hex cell assertions run through the xterm.js harness in QA.
//
// RED first: ToolExecution + its methods do not exist until GREEN.

import (
	"strings"
	"testing"
)

func newTestToolExec(name, cmd string) *ToolExecution {
	return NewToolExecution(ToolCall{
		ID:   "call-1",
		Name: name,
		Args: map[string]any{"command": cmd},
	}, DefaultRenderTheme())
}

func TestToolExecution_PendingRow(t *testing.T) {
	te := newTestToolExec("bash", "ls -la")
	lines := te.Render(80)
	joined := strings.Join(lines, "\n")
	// grok pending row: guide + marker + verb + command.
	if !strings.Contains(joined, "┃") || !strings.Contains(joined, "◆") {
		t.Fatalf("pending row missing grok glyphs: %q", joined)
	}
	if !strings.Contains(joined, "ls -la") {
		t.Fatalf("pending row missing command: %q", joined)
	}
}

func TestToolExecution_HookCountBadge(t *testing.T) {
	te := newTestToolExec("bash", "make test")
	te.SetHookCount(3)
	joined := strings.Join(te.Render(80), "\n")
	if !strings.Contains(joined, "[hooks: 3]") {
		t.Fatalf("hook badge missing: %q", joined)
	}
	// Zero hooks → no badge.
	te2 := newTestToolExec("bash", "make test")
	joined2 := strings.Join(te2.Render(80), "\n")
	if strings.Contains(joined2, "[hooks:") {
		t.Fatalf("badge shown for zero hooks: %q", joined2)
	}
}

func TestToolExecution_ResultBodyAfterCompletion(t *testing.T) {
	te := newTestToolExec("bash", "echo hi")
	te.SetResult(ToolResult{
		Content: []ContentBlock{{Type: "text", Text: "hi\n"}},
		IsError: false,
	})
	joined := strings.Join(te.Render(80), "\n")
	if !strings.Contains(joined, "hi") {
		t.Fatalf("result body missing output: %q", joined)
	}
}

func TestToolExecution_ErrorResultStyling(t *testing.T) {
	te := newTestToolExec("bash", "false")
	te.SetResult(ToolResult{
		Content: []ContentBlock{{Type: "text", Text: "command failed"}},
		IsError: true,
	})
	if !te.IsError() {
		t.Fatalf("error result not flagged")
	}
	joined := strings.Join(te.Render(80), "\n")
	if !strings.Contains(joined, "command failed") {
		t.Fatalf("error body missing: %q", joined)
	}
}

func TestToolExecution_CollapseExpand(t *testing.T) {
	// A long multi-line output collapses by default and expands via setExpanded.
	var b strings.Builder
	for i := 0; i < 40; i++ {
		b.WriteString("line ")
		b.WriteByte(byte('0' + i%10))
		b.WriteByte('\n')
	}
	te := newTestToolExec("bash", "seq 40")
	te.SetResult(ToolResult{Content: []ContentBlock{{Type: "text", Text: b.String()}}})

	collapsed := te.Render(80)
	te.SetExpanded(true)
	expanded := te.Render(80)
	if len(expanded) <= len(collapsed) {
		t.Fatalf("expanded (%d) not longer than collapsed (%d)", len(expanded), len(collapsed))
	}
}

func TestToolExecution_RenderCacheReusedOnSameSignature(t *testing.T) {
	te := newTestToolExec("bash", "echo hi")
	te.SetResult(ToolResult{Content: []ContentBlock{{Type: "text", Text: "hi"}}})
	first := te.Render(80)
	// Same width + no state change → identical cached lines (pointer-equal slice
	// contents), and the cache signature must be stable.
	sig1 := te.RenderSignature()
	second := te.Render(80)
	sig2 := te.RenderSignature()
	if sig1 != sig2 {
		t.Fatalf("signature unstable: %s vs %s", sig1, sig2)
	}
	if strings.Join(first, "\n") != strings.Join(second, "\n") {
		t.Fatalf("cached render differs across identical calls")
	}
	// State change → different signature (cache invalidated).
	te.SetExpanded(true)
	if te.RenderSignature() == sig1 {
		t.Fatalf("signature unchanged after setExpanded")
	}
}

func TestToolExecution_NoOrphanSpinnerOnAbort(t *testing.T) {
	// A pending tool that is aborted (result marked aborted/error) must stop its
	// spinner: the final render carries no spinner frame glyph. This guards the
	// acceptance criterion "no orphan spinner on abort".
	te := newTestToolExec("bash", "sleep 100")
	te.MarkPending()
	te.Abort()
	joined := strings.Join(te.Render(80), "\n")
	for _, frame := range SpinnerFramesForTest() {
		if strings.Contains(joined, frame) {
			t.Fatalf("orphan spinner frame %q present after abort: %q", frame, joined)
		}
	}
}
