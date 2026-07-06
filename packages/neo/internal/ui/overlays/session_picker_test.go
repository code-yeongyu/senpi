package overlays_test

import (
	"strings"
	"testing"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// session_picker_test.go ports the session-selector-path-delete.test.ts +
// session-selector-rename.test.ts contracts: guarded ctrl+d confirmation,
// ctrl+backspace only-when-empty delete, rename flow, sort/path/named toggles,
// switch on confirm, and active-session delete guard.

func pickerSessions() []store.SessionInfo {
	return []store.SessionInfo{
		{ID: "a", Path: "/tmp/a.jsonl", Name: "", Modified: date("2026-01-02T00:00:00Z"), FirstMessage: "hello a"},
		{ID: "b", Path: "/tmp/b.jsonl", Name: "Named B", Modified: date("2026-01-01T00:00:00Z"), FirstMessage: "hello b"},
	}
}

func newPicker(t *testing.T, active string) *overlays.SessionPicker {
	t.Helper()
	return overlays.NewSessionPicker(overlays.SessionPickerOptions{
		Sessions:    pickerSessions(),
		ActivePath:  active,
		AllMessages: map[string]string{"/tmp/a.jsonl": "hello a", "/tmp/b.jsonl": "hello b"},
	})
}

// TestPickerConfirmSwitches: enter on the highlighted session emits
// switch_session with its path.
func TestPickerConfirmSwitches(t *testing.T) {
	o := newPicker(t, "")
	kb := newKB(t)
	res := o.HandleKey("\n", kb, "")
	if res.Kind != overlays.OutcomeSelect || res.Command != "switch_session" {
		t.Fatalf("got %+v, want switch_session select", res)
	}
	if res.Fields["path"] != "/tmp/a.jsonl" {
		t.Errorf("path = %v, want /tmp/a.jsonl", res.Fields["path"])
	}
}

// TestPickerCtrlDGuardedConfirm: ctrl+d enters delete-confirmation (does not
// delete immediately); a second enter deletes.
func TestPickerCtrlDGuardedConfirm(t *testing.T) {
	o := newPicker(t, "")
	kb := newKB(t)
	res := o.HandleKey("\x04", kb, "") // ctrl+d
	if res.Kind == overlays.OutcomeSelect {
		t.Fatalf("ctrl+d must not delete immediately")
	}
	if o.ConfirmingDeletePath() != "/tmp/a.jsonl" {
		t.Errorf("confirming path = %q, want /tmp/a.jsonl", o.ConfirmingDeletePath())
	}
	res2 := o.HandleKey("\n", kb, "") // confirm delete
	if res2.Kind != overlays.OutcomeSelect || res2.FileOp != "delete_session" {
		t.Fatalf("got %+v, want delete_session file op", res2)
	}
	if res2.Fields["path"] != "/tmp/a.jsonl" {
		t.Errorf("delete path = %v, want /tmp/a.jsonl", res2.Fields["path"])
	}
}

// TestPickerCtrlBackspaceOnlyWhenEmpty: ctrl+backspace deletes only when the
// search query is empty; with a non-empty query it is not treated as delete.
func TestPickerCtrlBackspaceOnlyWhenEmpty(t *testing.T) {
	o := newPicker(t, "")
	kb := newKB(t)
	o.HandleKey("a", kb, "") // non-empty query
	o.HandleKey("\x1b[127;5u", kb, "")
	if o.ConfirmingDeletePath() != "" {
		t.Errorf("ctrl+backspace with non-empty query must not confirm delete; got %q", o.ConfirmingDeletePath())
	}
}

// TestPickerActiveSessionDeleteGuard: ctrl+d on the active session errors and
// does not enter confirmation.
func TestPickerActiveSessionDeleteGuard(t *testing.T) {
	o := newPicker(t, "/tmp/a.jsonl") // session a is active
	kb := newKB(t)
	o.HandleKey("\x04", kb, "")
	if o.ConfirmingDeletePath() != "" {
		t.Errorf("must not confirm delete of active session")
	}
	if o.LastError() != "Cannot delete the currently active session" {
		t.Errorf("error = %q, want active-session guard message", o.LastError())
	}
}

// TestPickerRename: ctrl+r starts rename mode; typing + enter emits
// set_session_name for the highlighted session.
func TestPickerRename(t *testing.T) {
	o := newPicker(t, "")
	kb := newKB(t)
	o.HandleKey("\x12", kb, "") // ctrl+r
	if !o.Renaming() {
		t.Fatalf("ctrl+r must enter rename mode")
	}
	for _, ch := range "New Name" {
		o.HandleKey(string(ch), kb, "")
	}
	res := o.HandleKey("\n", kb, "")
	if res.Kind != overlays.OutcomeSelect || res.Command != "set_session_name" {
		t.Fatalf("got %+v, want set_session_name", res)
	}
	if res.Fields["name"] != "New Name" {
		t.Errorf("name = %v, want 'New Name'", res.Fields["name"])
	}
}

// TestPickerNamedFilterToggle: ctrl+n toggles the named-only filter.
func TestPickerNamedFilterToggle(t *testing.T) {
	o := newPicker(t, "")
	kb := newKB(t)
	if o.NameFilter() != overlays.NameFilterAll {
		t.Fatalf("initial name filter = %v, want all", o.NameFilter())
	}
	o.HandleKey("\x0e", kb, "") // ctrl+n
	if o.NameFilter() != overlays.NameFilterNamed {
		t.Errorf("after ctrl+n = %v, want named", o.NameFilter())
	}
	// Only the named session remains visible.
	if got := o.VisibleSessionIDs(); len(got) != 1 || got[0] != "b" {
		t.Errorf("visible = %v, want [b]", got)
	}
}

// TestPickerSortToggle: ctrl+s cycles the sort mode.
func TestPickerSortToggle(t *testing.T) {
	o := newPicker(t, "")
	kb := newKB(t)
	before := o.SortMode()
	o.HandleKey("\x13", kb, "") // ctrl+s
	if o.SortMode() == before {
		t.Errorf("ctrl+s must change sort mode; stayed %v", o.SortMode())
	}
}

// TestPickerPathToggle: ctrl+p toggles the path display.
func TestPickerPathToggle(t *testing.T) {
	o := newPicker(t, "")
	kb := newKB(t)
	before := o.ShowPath()
	o.HandleKey("\x10", kb, "") // ctrl+p (session scope: togglePath)
	if o.ShowPath() == before {
		t.Errorf("ctrl+p must toggle path display")
	}
}

// TestPickerEmptyDirNoCrash: an empty session list renders a notice and enter is
// a no-op (failure-path scenario).
func TestPickerEmptyDirNoCrash(t *testing.T) {
	o := overlays.NewSessionPicker(overlays.SessionPickerOptions{Sessions: nil})
	kb := newKB(t)
	res := o.HandleKey("\n", kb, "")
	if res.Kind == overlays.OutcomeSelect {
		t.Errorf("confirm on empty picker must not select")
	}
	_ = o.RenderPlain(120) // must not panic
}

// TestPickerCancelRestores: esc restores editor text.
func TestPickerCancelRestores(t *testing.T) {
	o := newPicker(t, "")
	kb := newKB(t)
	res := o.HandleKey("\x1b", kb, "the draft")
	if res.Kind != overlays.OutcomeCancel || res.RestoreText != "the draft" {
		t.Errorf("cancel/restore failed: %+v", res)
	}
}

// TestPickerShowsRenameHintInteractive ports session-selector-rename.test.ts
// "shows rename hint in interactive /resume picker configuration": when the
// picker is built with ShowRenameHint=true, the rendered hint line includes the
// rename binding's key text (drawn LIVE from the keybinding registry, not
// hardcoded) followed by the "rename" label — mirroring
// keyHint("app.session.rename", "rename").
func TestPickerShowsRenameHintInteractive(t *testing.T) {
	kb := newKB(t)
	o := overlays.NewSessionPicker(overlays.SessionPickerOptions{
		Sessions:       pickerSessions(),
		ShowRenameHint: true,
		Keybindings:    kb,
	})
	out := strings.Join(o.RenderPlain(120), "\n")
	// The rename key text comes from the registry (default ctrl+r); assert
	// against the registry-resolved key so a user override would be reflected.
	renameKeys := kb.Keys("app.session.rename")
	if len(renameKeys) == 0 {
		t.Fatalf("registry has no keys for app.session.rename")
	}
	if !strings.Contains(out, renameKeys[0]) {
		t.Errorf("interactive picker hint must show rename key %q; got:\n%s", renameKeys[0], out)
	}
	if !strings.Contains(out, "rename") {
		t.Errorf("interactive picker hint must show 'rename' label; got:\n%s", out)
	}
}

// TestPickerHidesRenameHintResume ports session-selector-rename.test.ts "does
// not show rename hint in --resume picker configuration": when ShowRenameHint is
// false, neither the rename key text nor the "rename" label appears.
func TestPickerHidesRenameHintResume(t *testing.T) {
	kb := newKB(t)
	o := overlays.NewSessionPicker(overlays.SessionPickerOptions{
		Sessions:       pickerSessions(),
		ShowRenameHint: false,
		Keybindings:    kb,
	})
	out := strings.Join(o.RenderPlain(120), "\n")
	renameKeys := kb.Keys("app.session.rename")
	if len(renameKeys) > 0 && strings.Contains(out, renameKeys[0]) {
		t.Errorf("resume picker must NOT show rename key %q; got:\n%s", renameKeys[0], out)
	}
	if strings.Contains(out, "rename") {
		t.Errorf("resume picker must NOT show 'rename' label; got:\n%s", out)
	}
}

var _ = time.Now
