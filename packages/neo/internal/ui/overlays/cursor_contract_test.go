package overlays_test

import (
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// cursor_contract_test.go enforces the task-5 hardware-cursor/IME contract for
// every overlay text input: CursorCol must equal the VISIBLE-WIDTH column of the
// logical insertion point, so the app shell can place the real terminal cursor
// there and CJK IME candidate windows anchor correctly. CJK glyphs are width 2,
// so composing "한글" (2 clusters × 2 cols) puts the cursor at column 4.

// TestModelSelectorCursorAtInsertionPoint: after typing ASCII + CJK into the
// search input, CursorCol equals the sum of visible widths.
func TestModelSelectorCursorAtInsertionPoint(t *testing.T) {
	o := overlays.NewModelSelector(overlays.ModelSelectorOptions{Models: fauxModels(), Favorites: overlays.Favorites()})
	kb := newKB(t)
	// Type "ab" (2 cols) then "한글" (each wide = 2 cols → 4). Total = 6.
	for _, s := range []string{"a", "b", "한", "글"} {
		o.HandleKey(s, kb, "")
	}
	if got := o.CursorCol(); got != 6 {
		t.Errorf("CursorCol = %d, want 6 (ab=2 + 한글=4); hardware cursor must sit at the insertion point", got)
	}
}

// TestSessionPickerRenameCursorAtInsertionPoint: while renaming, CursorCol tracks
// the rename input's insertion column (CJK-aware).
func TestSessionPickerRenameCursorAtInsertionPoint(t *testing.T) {
	o := overlays.NewSessionPicker(overlays.SessionPickerOptions{
		Sessions: pickerSessions(),
	})
	kb := newKB(t)
	o.HandleKey("\x12", kb, "") // ctrl+r -> rename mode (initial value empty for session a)
	// Selected session a has no name; rename buffer starts empty.
	for _, s := range []string{"x", "が"} { // x=1 col, が(wide)=2 cols -> 3
		o.HandleKey(s, kb, "")
	}
	if got := o.CursorCol(); got != 3 {
		t.Errorf("rename CursorCol = %d, want 3 (x=1 + が=2)", got)
	}
}

// TestTextInputCursorMovementCJK: left/right arrows move by whole grapheme
// clusters, so the cursor column steps by the cluster's visible width.
func TestTextInputCursorMovementCJK(t *testing.T) {
	o := overlays.NewModelSelector(overlays.ModelSelectorOptions{Models: fauxModels(), Favorites: overlays.Favorites()})
	kb := newKB(t)
	for _, s := range []string{"한", "글"} { // 4 cols, cursor at end
		o.HandleKey(s, kb, "")
	}
	if got := o.CursorCol(); got != 4 {
		t.Fatalf("initial CursorCol = %d, want 4", got)
	}
	o.HandleKey("\x1b[D", kb, "") // left one cluster -> after 한 (2 cols)
	if got := o.CursorCol(); got != 2 {
		t.Errorf("after left, CursorCol = %d, want 2 (moved back one wide cluster)", got)
	}
}
