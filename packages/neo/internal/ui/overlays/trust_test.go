package overlays_test

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// trust_test.go ports packages/coding-agent/test/trust-selector.test.ts. The
// options come from getProjectTrustOptions (trust-manager.ts:65-95); the
// component renders the saved-decision line, the current-session line, and a
// ✓-marked list, and enter selects the highlighted option.

func newKB(t *testing.T) *keybindings.Manager {
	t.Helper()
	return keybindings.NewManager(nil)
}

func trustText(t *testing.T, o *overlays.TrustSelector, width int) string {
	t.Helper()
	return strings.Join(o.RenderPlain(width), "\n")
}

// TestTrustMarksSavedTrustedDecision ports "marks the saved trusted decision".
func TestTrustMarksSavedTrustedDecision(t *testing.T) {
	o := overlays.NewTrustSelector(overlays.TrustOptions{
		CWD:            "/project",
		SavedDecision:  &overlays.TrustStoreEntry{Path: "/project", Decision: true},
		ProjectTrusted: true,
	})
	out := trustText(t, o, 120)
	if !strings.Contains(out, "Saved decision: trusted (/project)") {
		t.Errorf("missing saved-decision line; got:\n%s", out)
	}
	if !strings.Contains(out, "Current session: trusted") {
		t.Errorf("missing current-session line; got:\n%s", out)
	}
	if !strings.Contains(out, "Trust ✓") {
		t.Errorf("expected 'Trust ✓'; got:\n%s", out)
	}
	if strings.Contains(out, "Do not trust ✓") {
		t.Errorf("did not expect 'Do not trust ✓'; got:\n%s", out)
	}
}

// TestTrustSelectsDecision ports "selects a trust decision": enter on the
// default-selected first option yields Trust with the cwd update.
func TestTrustSelectsDecision(t *testing.T) {
	o := overlays.NewTrustSelector(overlays.TrustOptions{
		CWD:            "/project",
		SavedDecision:  nil,
		ProjectTrusted: false,
	})
	kb := newKB(t)
	out := o.HandleKey("\n", kb, "saved-editor")
	if out.Kind != overlays.OutcomeSelect {
		t.Fatalf("kind = %v, want select", out.Kind)
	}
	sel := o.Selection()
	if !sel.Trusted {
		t.Errorf("Trusted = false, want true")
	}
	if len(sel.Updates) != 1 || sel.Updates[0].Path != "/project" || sel.Updates[0].Decision == nil || !*sel.Updates[0].Decision {
		t.Errorf("Updates = %+v, want [{/project true}]", sel.Updates)
	}
}

// TestTrustInheritedLabel ports "labels saved ancestor decisions as inherited".
func TestTrustInheritedLabel(t *testing.T) {
	o := overlays.NewTrustSelector(overlays.TrustOptions{
		CWD:            "/parent/project/nested",
		SavedDecision:  &overlays.TrustStoreEntry{Path: "/parent", Decision: true},
		ProjectTrusted: true,
	})
	out := trustText(t, o, 120)
	if !strings.Contains(out, "Saved decision: trusted (inherited from /parent)") {
		t.Errorf("missing inherited label; got:\n%s", out)
	}
}

// TestTrustParentOption ports "adds a trust parent option": the parent option is
// listed, and selecting it (default index 0 is the parent because it is the
// saved option) yields both parent + cwd updates.
func TestTrustParentOption(t *testing.T) {
	o := overlays.NewTrustSelector(overlays.TrustOptions{
		CWD:            "/parent/project",
		SavedDecision:  &overlays.TrustStoreEntry{Path: "/parent", Decision: true},
		ProjectTrusted: true,
	})
	out := trustText(t, o, 120)
	if !strings.Contains(out, "Saved decision: trusted (inherited from /parent)") {
		t.Errorf("missing inherited label; got:\n%s", out)
	}
	if !strings.Contains(out, "Trust parent folder (/parent) ✓") {
		t.Errorf("missing parent option with ✓; got:\n%s", out)
	}

	kb := newKB(t)
	res := o.HandleKey("\n", kb, "editor")
	if res.Kind != overlays.OutcomeSelect {
		t.Fatalf("kind = %v, want select", res.Kind)
	}
	sel := o.Selection()
	if !sel.Trusted {
		t.Errorf("Trusted = false, want true")
	}
	if len(sel.Updates) != 2 {
		t.Fatalf("Updates = %+v, want 2 (parent true, cwd null)", sel.Updates)
	}
	if sel.Updates[0].Path != "/parent" || sel.Updates[0].Decision == nil || !*sel.Updates[0].Decision {
		t.Errorf("Updates[0] = %+v, want {/parent true}", sel.Updates[0])
	}
	if sel.Updates[1].Path != "/parent/project" || sel.Updates[1].Decision != nil {
		t.Errorf("Updates[1] = %+v, want {/parent/project null}", sel.Updates[1])
	}
}

// TestTrustCancelRestoresEditor asserts the shared save/restore semantics: esc
// cancels and carries the saved editor text back for restoration.
func TestTrustCancelRestoresEditor(t *testing.T) {
	o := overlays.NewTrustSelector(overlays.TrustOptions{CWD: "/project"})
	kb := newKB(t)
	res := o.HandleKey("\x1b", kb, "my draft text")
	if res.Kind != overlays.OutcomeCancel {
		t.Fatalf("kind = %v, want cancel", res.Kind)
	}
	if res.RestoreText != "my draft text" {
		t.Errorf("RestoreText = %q, want 'my draft text'", res.RestoreText)
	}
}
