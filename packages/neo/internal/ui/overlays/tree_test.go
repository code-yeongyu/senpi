package overlays_test

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// tree_test.go ports the tree-selector.ts navigation contract: fold/unfold,
// filter modes (default/no-tools/user-only/labeled-only/all) with direct toggles
// and forward/backward cycling, label-timestamp toggle, and fork-from-node on
// confirm.

func sampleTree() *overlays.TreeNode {
	return &overlays.TreeNode{
		ID: "root", Kind: "message", Role: "user", Text: "root question",
		Children: []*overlays.TreeNode{
			{ID: "a1", Kind: "message", Role: "assistant", Text: "assistant reply",
				Children: []*overlays.TreeNode{
					{ID: "t1", Kind: "message", Role: "tool", Text: "tool output"},
					{ID: "u2", Kind: "message", Role: "user", Text: "follow up", Label: "milestone"},
				}},
		},
	}
}

// TestTreeConfirmForksFromNode: enter on the highlighted node emits fork with its
// entry id (fork-from-node).
func TestTreeConfirmForksFromNode(t *testing.T) {
	o := overlays.NewTreeNavigator(overlays.TreeOptions{Root: sampleTree(), CurrentLeafID: "u2"})
	kb := newKB(t)
	res := o.HandleKey("\n", kb, "")
	if res.Kind != overlays.OutcomeSelect || res.Command != "fork" {
		t.Fatalf("got %+v, want fork select", res)
	}
	if res.Fields["entryId"] == nil {
		t.Errorf("fork must carry the selected entryId; got %+v", res.Fields)
	}
}

// TestTreeFilterUserOnlyToggle: ctrl+u toggles user-only filter (only user
// messages visible); ctrl+u again returns to default.
func TestTreeFilterUserOnlyToggle(t *testing.T) {
	o := overlays.NewTreeNavigator(overlays.TreeOptions{Root: sampleTree(), CurrentLeafID: "u2"})
	kb := newKB(t)
	o.HandleKey("\x15", kb, "") // ctrl+u
	if o.FilterMode() != "user-only" {
		t.Fatalf("ctrl+u -> %q, want user-only", o.FilterMode())
	}
	ids := o.VisibleNodeIDs()
	for _, id := range ids {
		if id == "t1" || id == "a1" {
			t.Errorf("user-only filter must hide non-user nodes; saw %q in %v", id, ids)
		}
	}
	o.HandleKey("\x15", kb, "") // ctrl+u again -> default
	if o.FilterMode() != "default" {
		t.Errorf("second ctrl+u -> %q, want default", o.FilterMode())
	}
}

// TestTreeFilterCycleForward: ctrl+o cycles default → no-tools → user-only →
// labeled-only → all → default.
func TestTreeFilterCycleForward(t *testing.T) {
	o := overlays.NewTreeNavigator(overlays.TreeOptions{Root: sampleTree(), CurrentLeafID: "u2"})
	kb := newKB(t)
	want := []string{"no-tools", "user-only", "labeled-only", "all", "default"}
	for _, w := range want {
		o.HandleKey("\x0f", kb, "") // ctrl+o
		if o.FilterMode() != w {
			t.Fatalf("cycle forward -> %q, want %q", o.FilterMode(), w)
		}
	}
}

// TestTreeFilterCycleBackward: shift+ctrl+o cycles backward from default → all.
func TestTreeFilterCycleBackward(t *testing.T) {
	keybindings.SetKittyProtocolActive(true)
	defer keybindings.SetKittyProtocolActive(false)
	o := overlays.NewTreeNavigator(overlays.TreeOptions{Root: sampleTree(), CurrentLeafID: "u2"})
	kb := newKB(t)
	o.HandleKey("\x1b[111;6u", kb, "") // shift+ctrl+o (kitty encoding)
	if o.FilterMode() != "all" {
		t.Errorf("cycle backward from default -> %q, want all", o.FilterMode())
	}
}

// TestTreeToggleLabelTimestamp: shift+t toggles the label-timestamp display.
func TestTreeToggleLabelTimestamp(t *testing.T) {
	keybindings.SetKittyProtocolActive(true)
	defer keybindings.SetKittyProtocolActive(false)
	o := overlays.NewTreeNavigator(overlays.TreeOptions{Root: sampleTree(), CurrentLeafID: "u2"})
	kb := newKB(t)
	before := o.ShowLabelTimestamps()
	o.HandleKey("\x1b[116;2u", kb, "") // shift+t
	if o.ShowLabelTimestamps() == before {
		t.Errorf("shift+t must toggle label timestamps")
	}
}

// TestTreeFoldUnfold: ctrl+left folds a foldable node (hiding its subtree);
// ctrl+right unfolds it.
func TestTreeFoldUnfold(t *testing.T) {
	o := overlays.NewTreeNavigator(overlays.TreeOptions{Root: sampleTree(), CurrentLeafID: "u2"})
	kb := newKB(t)
	// Select the root (foldable). Move to top.
	o.SelectByID("root")
	o.HandleKey("\x1b[1;5D", kb, "") // ctrl+left = foldOrUp
	if !o.IsFolded("root") {
		t.Fatalf("ctrl+left on foldable root must fold it")
	}
	visible := o.VisibleNodeIDs()
	for _, id := range visible {
		if id == "a1" || id == "u2" {
			t.Errorf("folded subtree must be hidden; saw %q", id)
		}
	}
	o.HandleKey("\x1b[1;5C", kb, "") // ctrl+right = unfoldOrDown
	if o.IsFolded("root") {
		t.Errorf("ctrl+right must unfold root")
	}
}

// TestTreeCancelRestores: esc with an empty search cancels and restores editor.
func TestTreeCancelRestores(t *testing.T) {
	o := overlays.NewTreeNavigator(overlays.TreeOptions{Root: sampleTree(), CurrentLeafID: "u2"})
	kb := newKB(t)
	res := o.HandleKey("\x1b", kb, "my draft")
	if res.Kind != overlays.OutcomeCancel || res.RestoreText != "my draft" {
		t.Errorf("cancel/restore failed: %+v", res)
	}
}

var _ = strings.Contains
