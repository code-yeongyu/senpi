package overlays_test

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// TestThinkingSelectorPreselectsCurrent ports thinking-selector.ts: the current
// level is preselected; the list shows each level's description; confirming
// emits a set_thinking_level command with the highlighted value.
func TestThinkingSelectorPreselectsCurrent(t *testing.T) {
	levels := []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}
	o := overlays.NewThinkingSelector("medium", levels)

	if o.SelectedValue() != "medium" {
		t.Errorf("preselected = %q, want medium", o.SelectedValue())
	}
	out := strings.Join(o.RenderPlain(120), "\n")
	if !strings.Contains(out, "Moderate reasoning (~8k tokens)") {
		t.Errorf("missing medium description; got:\n%s", out)
	}
	if !strings.Contains(out, "No reasoning") {
		t.Errorf("missing off description; got:\n%s", out)
	}
}

// TestThinkingSelectorConfirm emits set_thinking_level for the selected level.
func TestThinkingSelectorConfirm(t *testing.T) {
	levels := []string{"off", "low", "high"}
	o := overlays.NewThinkingSelector("off", levels)
	kb := newKB(t)
	// Move down twice: off -> low -> high.
	o.HandleKey("\x1b[B", kb, "")
	o.HandleKey("\x1b[B", kb, "")
	res := o.HandleKey("\n", kb, "")
	if res.Kind != overlays.OutcomeSelect {
		t.Fatalf("kind = %v, want select", res.Kind)
	}
	if res.Command != "set_thinking_level" {
		t.Errorf("command = %q, want set_thinking_level", res.Command)
	}
	if res.Fields["level"] != "high" {
		t.Errorf("level = %v, want high", res.Fields["level"])
	}
}

// TestThinkingSelectorCancelRestores checks esc restores editor text.
func TestThinkingSelectorCancelRestores(t *testing.T) {
	o := overlays.NewThinkingSelector("off", []string{"off", "low"})
	kb := newKB(t)
	res := o.HandleKey("\x1b", kb, "draft here")
	if res.Kind != overlays.OutcomeCancel || res.RestoreText != "draft here" {
		t.Errorf("cancel/restore failed: %+v", res)
	}
}

// TestThemeSelectorPreselectsCurrent ports theme-selector.ts: available themes
// are listed, the current one is preselected and marked "(current)".
func TestThemeSelectorPreselectsCurrent(t *testing.T) {
	themes := []string{"grok-night", "grok-day", "custom-one"}
	o := overlays.NewThemeSelector("grok-day", themes)
	if o.SelectedValue() != "grok-day" {
		t.Errorf("preselected = %q, want grok-day", o.SelectedValue())
	}
	out := strings.Join(o.RenderPlain(120), "\n")
	if !strings.Contains(out, "(current)") {
		t.Errorf("missing (current) marker; got:\n%s", out)
	}
}

// TestThemeSelectorPreviewOnMove asserts moving the selection reports a preview
// value (the TS onSelectionChange → onPreview hook).
func TestThemeSelectorPreviewOnMove(t *testing.T) {
	themes := []string{"grok-night", "grok-day"}
	o := overlays.NewThemeSelector("grok-night", themes)
	kb := newKB(t)
	o.HandleKey("\x1b[B", kb, "") // down -> grok-day
	if o.PreviewValue() != "grok-day" {
		t.Errorf("preview = %q, want grok-day", o.PreviewValue())
	}
}

// TestThemeSelectorConfirmNeoKey asserts confirming emits a settings-write to the
// neo.theme key (never the classic theme key), per the guardrail.
func TestThemeSelectorConfirmNeoKey(t *testing.T) {
	o := overlays.NewThemeSelector("grok-night", []string{"grok-night", "grok-day"})
	kb := newKB(t)
	o.HandleKey("\x1b[B", kb, "") // down -> grok-day
	res := o.HandleKey("\n", kb, "")
	if res.Kind != overlays.OutcomeSelect {
		t.Fatalf("kind = %v, want select", res.Kind)
	}
	if res.FileOp != "write_settings" {
		t.Errorf("FileOp = %q, want write_settings", res.FileOp)
	}
	if res.Fields["key"] != "neo.theme" {
		t.Errorf("key = %v, want neo.theme (never classic 'theme')", res.Fields["key"])
	}
	if res.Fields["value"] != "grok-day" {
		t.Errorf("value = %v, want grok-day", res.Fields["value"])
	}
}
