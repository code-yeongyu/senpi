package builtinext

import (
	"path/filepath"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

const (
	historyMaxVisibleRows = 15
	historyMaxRendered    = 250
)

// selectListActions mirrors the SELECT_LIST_ACTIONS captured by the classic
// history overlay (overlay.ts:14-19): these actions are routed to the list, all
// other keystrokes edit the search input.
var selectListActions = []string{
	"tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel",
}

// HistorySearchOptions configures a HistorySearchOverlay.
type HistorySearchOptions struct {
	Entries       []HistoryEntry
	Theme         *theme.Theme
	Keybindings   *keybindings.Manager
	RequestRender func()
	// Done is called with (entry, selected): selected=false means cancelled.
	// The caller inserts entry.Text into the editor when selected (index.ts:53).
	Done func(HistoryEntry, bool)
}

// HistorySearchOverlay is the native port of history-search/overlay.ts: a search
// input above a fuzzy-filtered select list of prompts, framed by accent rules.
type HistorySearchOverlay struct {
	opts     HistorySearchOptions
	roles    roleStyler
	search   *searchInput
	list     *ui.SelectList
	filtered []HistoryEntry
	byIndex  map[string]HistoryEntry
	focused  bool
	topRule  *ui.DynamicBorder
	botRule  *ui.DynamicBorder
}

// NewHistorySearchOverlay builds the overlay and performs the initial (empty
// query) filter + list build.
func NewHistorySearchOverlay(opts HistorySearchOptions) *HistorySearchOverlay {
	accent := func(s string) string { return newRoleStyler(opts.Theme).fg("accent", s) }
	ov := &HistorySearchOverlay{
		opts:    opts,
		roles:   newRoleStyler(opts.Theme),
		search:  &searchInput{},
		byIndex: map[string]HistoryEntry{},
		topRule: ui.NewDynamicBorderColored(accent),
		botRule: ui.NewDynamicBorderColored(accent),
	}
	ov.rebuild()
	return ov
}

// SetFocused sets keyboard focus.
func (o *HistorySearchOverlay) SetFocused(v bool) { o.focused = v }

// SearchValue returns the current query.
func (o *HistorySearchOverlay) SearchValue() string { return o.search.value() }

// FilteredEntries returns the current filtered entries.
func (o *HistorySearchOverlay) FilteredEntries() []HistoryEntry { return o.filtered }

// HandleInput routes list-navigation actions to the list and all other input to
// the search box, rebuilding + re-rendering when the query changes (mirror of
// overlay.ts handleInput).
func (o *HistorySearchOverlay) HandleInput(input string) {
	km := o.opts.Keybindings
	for _, action := range selectListActions {
		if km.Matches(input, action) {
			o.handleListAction(action)
			return
		}
	}
	before := o.search.value()
	o.search.handleInput(input)
	if before != o.search.value() {
		o.rebuild()
		if o.opts.RequestRender != nil {
			o.opts.RequestRender()
		}
	}
}

func (o *HistorySearchOverlay) handleListAction(action string) {
	switch action {
	case "tui.select.up":
		o.list.MoveUp()
	case "tui.select.down":
		o.list.MoveDown()
	case "tui.select.confirm":
		if item, ok := o.list.SelectedItem(); ok {
			o.opts.Done(o.byIndex[item.Value], true)
			return
		}
		o.opts.Done(HistoryEntry{}, false)
	case "tui.select.cancel":
		o.opts.Done(HistoryEntry{}, false)
	}
	if o.opts.RequestRender != nil {
		o.opts.RequestRender()
	}
}

func (o *HistorySearchOverlay) rebuild() {
	o.byIndex = map[string]HistoryEntry{}
	o.filtered = FilterHistory(o.opts.Entries, o.search.value())
	rendered := o.filtered
	if len(rendered) > historyMaxRendered {
		rendered = rendered[:historyMaxRendered]
	}
	items := make([]ui.SelectItem, len(rendered))
	for i, e := range rendered {
		value := itoa(i)
		o.byIndex[value] = e
		items[i] = ui.SelectItem{
			Value:       value,
			Label:       collapseWhitespaceLine(e.Text),
			Description: describeHistoryEntry(e),
		}
	}
	maxVisible := historyMaxVisibleRows
	if len(items) < maxVisible {
		maxVisible = len(items)
	}
	if maxVisible < 1 {
		maxVisible = 1
	}
	o.list = ui.NewSelectList(items, maxVisible, o.listTheme(), ui.SelectListLayout{})
}

func (o *HistorySearchOverlay) listTheme() ui.SelectListTheme {
	r := o.roles
	return ui.SelectListTheme{
		SelectedPrefix: func(s string) string { return r.fg("accent", s) },
		SelectedText:   func(s string) string { return s },
		Description:    func(s string) string { return r.fg("muted", s) },
		ScrollInfo:     func(s string) string { return r.fg("dim", s) },
		NoMatch: func(s string) string {
			return r.fg("warning", strings.ReplaceAll(s, "commands", "prompts"))
		},
	}
}

// Render lays out the framed overlay (mirror of overlay.ts renderContainer).
func (o *HistorySearchOverlay) Render(width int) []string {
	r := o.roles
	title := r.fg("accent", r.boldText(" Search prompt history"))
	count := r.fg("dim", " "+itoa(len(o.filtered))+"/"+itoa(len(o.opts.Entries))+" prompts")

	lines := []string{}
	lines = append(lines, o.topRule.Render(width)...)
	lines = append(lines, title+count)
	lines = append(lines, o.search.render(width, r))
	lines = append(lines, o.list.Render(width)...)
	lines = append(lines, r.fg("dim", " Type to filter • ↑↓ navigate • enter select • esc close"))
	lines = append(lines, o.botRule.Render(width)...)
	return lines
}

// describeHistoryEntry mirrors overlay.ts describeEntry: "<cwdName>/<shortId> ·
// <relativeTime>". relativeTime is omitted from the deterministic label here to
// keep goldens stable; the session label is preserved for parity assertions.
func describeHistoryEntry(e HistoryEntry) string {
	shortID := e.SessionID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	cwdName := filepath.Base(e.CWD)
	if cwdName == "." || cwdName == string(filepath.Separator) {
		cwdName = ""
	}
	if cwdName != "" {
		return cwdName + "/" + shortID
	}
	return shortID
}

// searchInput is a minimal single-line rune buffer backing the history search
// box (the classic Input used here only needs printable-char insert + backspace
// for the overlay contract). Cursor rendering follows the grok "> <value>"
// prompt used by the classic Input.
type searchInput struct {
	runes []rune
}

func (s *searchInput) value() string { return string(s.runes) }

// handleInput appends printable input and handles backspace. Control sequences
// that are not the list actions (already routed away) are ignored.
func (s *searchInput) handleInput(input string) {
	switch input {
	case "\x7f", "\b": // backspace / DEL
		if len(s.runes) > 0 {
			s.runes = s.runes[:len(s.runes)-1]
		}
		return
	}
	// Ignore any remaining control/escape sequences.
	if len(input) == 1 && input[0] < 0x20 {
		return
	}
	if strings.HasPrefix(input, "\x1b") {
		return
	}
	for _, r := range input {
		if r >= 0x20 || r == '\t' {
			s.runes = append(s.runes, r)
		}
	}
}

func (s *searchInput) render(width int, r roleStyler) string {
	prompt := r.fg("accent", ">")
	return prompt + " " + s.value()
}

// collapseWhitespaceLine mirrors overlay.ts toSelectItem label:
// entry.text.replace(/[\r\n]+/g, " ").trim().
func collapseWhitespaceLine(text string) string {
	replacer := strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ")
	return strings.TrimSpace(replacer.Replace(text))
}
