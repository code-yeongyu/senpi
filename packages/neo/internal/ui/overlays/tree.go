package overlays

import (
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// tree.go ports the tree-selector.ts navigation contract: a session-tree browser
// with fold/unfold (ctrl+left/right), five filter modes (default/no-tools/
// user-only/labeled-only/all) via direct toggles (ctrl+d/t/u/l/a) and forward/
// backward cycling (ctrl+o / shift+ctrl+o), a label-timestamp toggle (shift+t),
// label editing (shift+l), and fork-from-node on confirm (enter → fork {entryId}).
// Every key resolves through the ScopeTree keybinding table.

// TreeNode mirrors the picker-relevant fields of SessionTreeNode
// (session-manager.ts): an entry id, the entry kind/role for filtering, its
// display text, an optional label, and children.
type TreeNode struct {
	ID       string
	Kind     string // entry type ("message", "branch_summary", ...)
	Role     string // message role ("user"/"assistant"/"tool") for filters
	Text     string
	Label    string
	Children []*TreeNode
}

// TreeFilterMode is the five-way filter mirroring FilterMode (tree-selector.ts:95).
type TreeFilterMode = string

var treeFilterOrder = []TreeFilterMode{"default", "no-tools", "user-only", "labeled-only", "all"}

// TreeOptions configures the navigator.
type TreeOptions struct {
	Root          *TreeNode
	CurrentLeafID string
}

// flatNode is a node paired with its depth for indented rendering.
type flatNode struct {
	node  *TreeNode
	depth int
}

// TreeNavigator is the tree overlay.
type TreeNavigator struct {
	root                *TreeNode
	currentLeaf         string
	filterMode          TreeFilterMode
	folded              map[string]bool
	showLabelTimestamps bool
	searchQuery         string
	filtered            []flatNode
	selectedIndex       int
	editingLabel        bool
	th                  *theme.Theme
}

// NewTreeNavigator builds the overlay, selecting the current leaf by default.
func NewTreeNavigator(opts TreeOptions) *TreeNavigator {
	th, _ := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	o := &TreeNavigator{
		root:        opts.Root,
		currentLeaf: opts.CurrentLeafID,
		filterMode:  "default",
		folded:      map[string]bool{},
		th:          th,
	}
	o.applyFilter()
	o.SelectByID(opts.CurrentLeafID)
	return o
}

// --- accessors ---------------------------------------------------------------

// FilterMode returns the active filter mode.
func (o *TreeNavigator) FilterMode() TreeFilterMode { return o.filterMode }

// ShowLabelTimestamps reports whether label timestamps are shown.
func (o *TreeNavigator) ShowLabelTimestamps() bool { return o.showLabelTimestamps }

// IsFolded reports whether a node id is folded.
func (o *TreeNavigator) IsFolded(id string) bool { return o.folded[id] }

// VisibleNodeIDs returns the currently visible node ids (test seam).
func (o *TreeNavigator) VisibleNodeIDs() []string {
	out := make([]string, len(o.filtered))
	for i, f := range o.filtered {
		out[i] = f.node.ID
	}
	return out
}

// SelectByID moves the selection to the node with id (no-op if not visible).
func (o *TreeNavigator) SelectByID(id string) {
	for i, f := range o.filtered {
		if f.node.ID == id {
			o.selectedIndex = i
			return
		}
	}
}

// HandleKey routes tree keys through the ScopeTree table.
func (o *TreeNavigator) HandleKey(data string, kb *keybindings.Manager, savedText string) Outcome {
	switch {
	case matches(kb, data, "tui.select.up"):
		o.moveUp()
		return none()
	case matches(kb, data, "tui.select.down"):
		o.moveDown()
		return none()
	case matchesInScope(kb, data, "app.tree.foldOrUp", keybindings.ScopeTree):
		o.foldOrUp()
		return none()
	case matchesInScope(kb, data, "app.tree.unfoldOrDown", keybindings.ScopeTree):
		o.unfoldOrDown()
		return none()
	case matches(kb, data, "tui.select.confirm"):
		if node, ok := o.selected(); ok {
			return selectCmd("fork", map[string]any{"entryId": node.ID})
		}
		return none()
	case matches(kb, data, "tui.select.cancel"):
		if o.searchQuery != "" {
			o.searchQuery = ""
			o.folded = map[string]bool{}
			o.applyFilter()
			return none()
		}
		return cancel(savedText)
	case matchesInScope(kb, data, "app.tree.filter.default", keybindings.ScopeTree):
		o.setFilter("default")
		return none()
	case matchesInScope(kb, data, "app.tree.filter.noTools", keybindings.ScopeTree):
		o.toggleFilter("no-tools")
		return none()
	case matchesInScope(kb, data, "app.tree.filter.userOnly", keybindings.ScopeTree):
		o.toggleFilter("user-only")
		return none()
	case matchesInScope(kb, data, "app.tree.filter.labeledOnly", keybindings.ScopeTree):
		o.toggleFilter("labeled-only")
		return none()
	case matchesInScope(kb, data, "app.tree.filter.all", keybindings.ScopeTree):
		o.toggleFilter("all")
		return none()
	case matchesInScope(kb, data, "app.tree.filter.cycleForward", keybindings.ScopeTree):
		o.cycleFilter(+1)
		return none()
	case matchesInScope(kb, data, "app.tree.filter.cycleBackward", keybindings.ScopeTree):
		o.cycleFilter(-1)
		return none()
	case matchesInScope(kb, data, "app.tree.editLabel", keybindings.ScopeTree):
		o.editingLabel = true
		if node, ok := o.selected(); ok {
			return selectFileOp("edit_label", map[string]any{"entryId": node.ID, "label": node.Label})
		}
		return none()
	case matchesInScope(kb, data, "app.tree.toggleLabelTimestamp", keybindings.ScopeTree):
		o.showLabelTimestamps = !o.showLabelTimestamps
		return none()
	}
	return none()
}

func (o *TreeNavigator) selected() (*TreeNode, bool) {
	if o.selectedIndex < 0 || o.selectedIndex >= len(o.filtered) {
		return nil, false
	}
	return o.filtered[o.selectedIndex].node, true
}

func (o *TreeNavigator) moveUp() {
	if len(o.filtered) == 0 {
		return
	}
	if o.selectedIndex == 0 {
		o.selectedIndex = len(o.filtered) - 1
	} else {
		o.selectedIndex--
	}
}

func (o *TreeNavigator) moveDown() {
	if len(o.filtered) == 0 {
		return
	}
	if o.selectedIndex == len(o.filtered)-1 {
		o.selectedIndex = 0
	} else {
		o.selectedIndex++
	}
}

// foldOrUp folds a foldable, unfolded node; otherwise moves up.
func (o *TreeNavigator) foldOrUp() {
	node, ok := o.selected()
	if ok && o.isFoldable(node.ID) && !o.folded[node.ID] {
		o.folded[node.ID] = true
		selID := node.ID
		o.applyFilter()
		o.SelectByID(selID)
		return
	}
	o.moveUp()
}

// unfoldOrDown unfolds a folded node; otherwise moves down.
func (o *TreeNavigator) unfoldOrDown() {
	node, ok := o.selected()
	if ok && o.folded[node.ID] {
		delete(o.folded, node.ID)
		selID := node.ID
		o.applyFilter()
		o.SelectByID(selID)
		return
	}
	o.moveDown()
}

// isFoldable reports whether a node has children (so it can hide a subtree).
func (o *TreeNavigator) isFoldable(id string) bool {
	var find func(n *TreeNode) *TreeNode
	find = func(n *TreeNode) *TreeNode {
		if n.ID == id {
			return n
		}
		for _, c := range n.Children {
			if r := find(c); r != nil {
				return r
			}
		}
		return nil
	}
	if o.root == nil {
		return false
	}
	n := find(o.root)
	return n != nil && len(n.Children) > 0
}

func (o *TreeNavigator) setFilter(mode TreeFilterMode) {
	o.filterMode = mode
	o.folded = map[string]bool{}
	o.applyFilter()
}

func (o *TreeNavigator) toggleFilter(mode TreeFilterMode) {
	if o.filterMode == mode {
		o.setFilter("default")
	} else {
		o.setFilter(mode)
	}
}

func (o *TreeNavigator) cycleFilter(delta int) {
	idx := indexOf(treeFilterOrder, o.filterMode)
	if idx < 0 {
		idx = 0
	}
	n := len(treeFilterOrder)
	next := (idx + delta) % n
	if next < 0 {
		next += n
	}
	o.setFilter(treeFilterOrder[next])
}

// applyFilter flattens the tree into the visible node list, honoring the fold set
// and the filter mode. A folded node's descendants are hidden; the filter mode
// drops nodes that do not pass the per-mode predicate (their children are still
// walked so a passing descendant remains reachable, mirroring the classic
// selector's node-level filter).
func (o *TreeNavigator) applyFilter() {
	o.filtered = nil
	if o.root == nil {
		return
	}
	var walk func(n *TreeNode, depth int)
	walk = func(n *TreeNode, depth int) {
		if o.nodePasses(n) {
			o.filtered = append(o.filtered, flatNode{node: n, depth: depth})
		}
		if o.folded[n.ID] {
			return
		}
		for _, c := range n.Children {
			walk(c, depth+1)
		}
	}
	walk(o.root, 0)
	if o.selectedIndex > len(o.filtered)-1 {
		o.selectedIndex = maxInt0(len(o.filtered) - 1)
	}
}

// nodePasses mirrors the per-mode node predicate (tree-selector.ts:638-647).
func (o *TreeNavigator) nodePasses(n *TreeNode) bool {
	switch o.filterMode {
	case "no-tools":
		return n.Role != "tool"
	case "user-only":
		return n.Role == "user"
	case "labeled-only":
		return strings.TrimSpace(n.Label) != ""
	default: // "default" and "all"
		return true
	}
}

// RenderPlain renders the tree without color for content assertions.
func (o *TreeNavigator) RenderPlain(width int) []string { return o.render(width, false) }

// RenderStyled renders the tree with grok styling for the QA harness.
func (o *TreeNavigator) RenderStyled(width int) []string { return o.render(width, true) }

func (o *TreeNavigator) render(width int, styled bool) []string {
	style := func(fn func() lipgloss.Style, s string) string {
		if !styled {
			return s
		}
		return fn().Render(s)
	}
	border := ui.NewDynamicBorder(o.th).Render(width)
	if !styled {
		for i, l := range border {
			border[i] = ui.StripANSI(l)
		}
	}
	lines := append([]string(nil), border...)
	lines = append(lines, style(o.th.AccentBlue, "Session tree"))
	lines = append(lines, style(o.th.TextMuted, "filter: "+o.filterMode))
	lines = append(lines, "")
	if len(o.filtered) == 0 {
		lines = append(lines, style(o.th.TextMuted, "  (no nodes)"))
		lines = append(lines, border...)
		return lines
	}
	for i, f := range o.filtered {
		indent := strings.Repeat("  ", f.depth)
		prefix := "  "
		text := f.node.Text
		if i == o.selectedIndex {
			prefix = style(o.th.AccentBlue, "→ ")
			text = style(o.th.AccentBlue, text)
		}
		row := prefix + indent + text
		if o.folded[f.node.ID] {
			row += style(o.th.TextMuted, " [folded]")
		}
		if lbl := strings.TrimSpace(f.node.Label); lbl != "" {
			row += style(o.th.AccentYellow, " «"+lbl+"»")
		}
		lines = append(lines, row)
	}
	lines = append(lines, border...)
	return lines
}
