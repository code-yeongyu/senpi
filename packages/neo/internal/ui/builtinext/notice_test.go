package builtinext

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// The third-party ctx.ui.custom notice dialog.
//
// VERIFIED CLASSIC RPC-MODE BEHAVIOR (rpc-mode.ts:237-241):
//
//	async custom() {
//	  // Custom UI not supported in RPC mode
//	  return undefined as never;
//	}
//
// ctx.ui.custom returns undefined SYNCHRONOUSLY with NO wire message. There is
// nothing for a default RPC client to render a dialog from today. Task 13
// (deferred) adds the additive neo-opt-in capability flag + the additive
// extension_ui_request{method:"custom_unsupported", extensionName} emission that
// a flagged host would send before returning undefined. For THIS task we
// implement and test ONLY:
//   - the Go notice dialog rendering, and
//   - a stub that exercises it from a custom_unsupported request.

// TestCustomUnsupportedNoticeRenders verifies the notice dialog renders the
// exact required copy including the extension name.
func TestCustomUnsupportedNoticeRenders(t *testing.T) {
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	ov := NewCustomUnsupportedNotice(CustomUnsupportedOptions{
		ExtensionName: "acme-widget",
		Theme:         th,
		Keybindings:   km,
		Done:          func() {},
		RequestRender: func() {},
	})
	joined := stripANSI(strings.Join(ov.Render(80), "\n"))
	want := "this extension UI requires the classic TUI: acme-widget"
	if !strings.Contains(joined, want) {
		t.Fatalf("notice dialog should contain %q, got:\n%s", want, joined)
	}
}

// TestCustomUnsupportedNoticeDismiss verifies esc/enter dismisses the dialog.
func TestCustomUnsupportedNoticeDismiss(t *testing.T) {
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	for _, key := range []string{"\x1b", "\r"} {
		done := 0
		ov := NewCustomUnsupportedNotice(CustomUnsupportedOptions{
			ExtensionName: "x", Theme: th, Keybindings: km,
			Done: func() { done++ }, RequestRender: func() {},
		})
		ov.HandleInput(key)
		if done != 1 {
			t.Fatalf("key %q should dismiss the notice once, got %d", key, done)
		}
	}
}

// TestCustomUnsupportedFromRequest is the stub that exercises the notice path
// from an additive extension_ui_request{method:"custom_unsupported"}. This is
// the exact request a task-13 capability-flagged host will emit; the Go side is
// wired here so task 13 only has to flip the TS emission on.
func TestCustomUnsupportedFromRequest(t *testing.T) {
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	req := bridge.ExtensionUIRequest{
		Type:   "extension_ui_request",
		ID:     "req-1",
		Method: "custom_unsupported",
		Fields: map[string]any{"extensionName": "third-party-ext"},
	}
	ov, ok := NoticeForRequest(req, NoticeDeps{Theme: th, Keybindings: km, Done: func() {}, RequestRender: func() {}})
	if !ok {
		t.Fatalf("custom_unsupported request should produce a notice dialog")
	}
	joined := stripANSI(strings.Join(ov.Render(80), "\n"))
	if !strings.Contains(joined, "third-party-ext") {
		t.Fatalf("notice should name the extension from the request, got:\n%s", joined)
	}

	// A non-custom_unsupported method must NOT produce a notice (additive-only).
	other := bridge.ExtensionUIRequest{Type: "extension_ui_request", ID: "req-2", Method: "notify"}
	if _, ok := NoticeForRequest(other, NoticeDeps{Theme: th, Keybindings: km}); ok {
		t.Fatalf("only custom_unsupported should route to the notice dialog")
	}
}
