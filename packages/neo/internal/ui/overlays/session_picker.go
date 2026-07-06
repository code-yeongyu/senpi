package overlays

import (
	"path/filepath"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// session_picker.go ports the SessionSelectorComponent state machine
// (session-selector.ts + session-selector-search.ts): a fuzzy-searchable session
// list driven off the NATIVE store scan, with rename (ctrl+r → set_session_name),
// GUARDED delete (ctrl+d enters confirmation; ctrl+backspace only when the query
// is empty; the active session cannot be deleted), sort-mode toggle (ctrl+s),
// path-display toggle (ctrl+p in the session scope), named-only filter (ctrl+n),
// and switch_session on confirm. Every key resolves through the ScopeSession
// keybinding table.

// SessionPickerOptions configures the picker.
type SessionPickerOptions struct {
	Sessions    []store.SessionInfo
	ActivePath  string            // the currently-active session file (delete guard)
	AllMessages map[string]string // path -> joined message text for search (optional)

	// ShowRenameHint mirrors SessionSelectorComponent's showRenameHint option:
	// the interactive /resume picker enables it, the read-only --resume picker
	// does not. When true the footer hint line surfaces the rename binding.
	ShowRenameHint bool
	// Keybindings resolves the rename hint's key text LIVE (override-aware).
	// Optional; when nil the picker loads the default registry so the hint still
	// reflects the shipped bindings.
	Keybindings *keybindings.Manager
}

// SessionPicker is the session-picker overlay.
type SessionPicker struct {
	sessions   []store.SessionInfo
	visible    []store.SessionInfo
	activePath string
	allMsgs    map[string]string

	input         *textInput
	selectedIndex int
	sortMode      SortMode
	nameFilter    NameFilter
	showPath      bool

	// delete confirmation + rename state.
	confirmingDeletePath string
	renaming             bool
	renameInput          *textInput
	lastError            string

	// showRenameHint gates the rename footer hint; kb resolves its key text.
	showRenameHint bool
	kb             *keybindings.Manager

	th *theme.Theme
}

// NewSessionPicker builds the picker, sorting by Modified descending by default
// (the store's activity-time — including the entry-timestamp fallback — drives
// the ordering).
func NewSessionPicker(opts SessionPickerOptions) *SessionPicker {
	th, _ := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	kb := opts.Keybindings
	if kb == nil {
		kb = keybindings.NewManager(nil)
	}
	o := &SessionPicker{
		sessions:       SortByModifiedDesc(opts.Sessions),
		activePath:     opts.ActivePath,
		allMsgs:        opts.AllMessages,
		input:          newTextInput(),
		renameInput:    newTextInput(),
		sortMode:       SortRecent,
		nameFilter:     NameFilterAll,
		showRenameHint: opts.ShowRenameHint,
		kb:             kb,
		th:             th,
	}
	o.recompute()
	return o
}

// recompute re-applies the name filter + query to the sorted sessions.
func (o *SessionPicker) recompute() {
	texts := make([]SessionText, len(o.sessions))
	for i, s := range o.sessions {
		texts[i] = SessionText{Info: s, AllMessagesText: o.allMsgs[s.Path]}
	}
	filtered := FilterAndSortSessions(texts, o.input.Value(), o.sortMode, o.nameFilter)
	o.visible = make([]store.SessionInfo, len(filtered))
	for i, f := range filtered {
		o.visible[i] = f.Info
	}
	if o.selectedIndex > len(o.visible)-1 {
		o.selectedIndex = maxInt0(len(o.visible) - 1)
	}
}

// --- accessors used by tests + the shell ------------------------------------

// SortMode returns the current sort mode.
func (o *SessionPicker) SortMode() NameFilterSort { return NameFilterSort(o.sortMode) }

// NameFilter returns the current name filter.
func (o *SessionPicker) NameFilter() NameFilter { return o.nameFilter }

// ShowPath reports whether the path column is shown.
func (o *SessionPicker) ShowPath() bool { return o.showPath }

// ConfirmingDeletePath returns the path awaiting delete confirmation ("" if none).
func (o *SessionPicker) ConfirmingDeletePath() string { return o.confirmingDeletePath }

// Renaming reports whether the picker is in rename mode.
func (o *SessionPicker) Renaming() bool { return o.renaming }

// LastError returns the last surfaced error message.
func (o *SessionPicker) LastError() string { return o.lastError }

// VisibleSessionIDs returns the filtered session ids (test seam).
func (o *SessionPicker) VisibleSessionIDs() []string {
	out := make([]string, len(o.visible))
	for i, s := range o.visible {
		out[i] = s.ID
	}
	return out
}

// CursorCol exposes the active input's insertion column for hardware-cursor
// placement (task-5 IME contract): the rename input when renaming, else search.
func (o *SessionPicker) CursorCol() int {
	if o.renaming {
		return o.renameInput.CursorCol()
	}
	return o.input.CursorCol()
}

// NameFilterSort is a display alias for SortMode used by accessors so the picker
// exposes its sort state without leaking the internal type name.
type NameFilterSort = SortMode

// HandleKey routes the picker's keys through the ScopeSession table.
func (o *SessionPicker) HandleKey(data string, kb *keybindings.Manager, savedText string) Outcome {
	o.lastError = ""

	// Rename mode captures typing + confirm/cancel first.
	if o.renaming {
		return o.handleRenameKey(data, kb)
	}

	// Delete confirmation mode: confirm deletes, cancel aborts.
	if o.confirmingDeletePath != "" {
		switch {
		case matches(kb, data, "tui.select.confirm"):
			path := o.confirmingDeletePath
			o.confirmingDeletePath = ""
			return selectFileOp("delete_session", map[string]any{"path": path})
		case matches(kb, data, "tui.select.cancel"):
			o.confirmingDeletePath = ""
			return none()
		}
		return none()
	}

	switch {
	case matchesInScope(kb, data, "app.session.rename", keybindings.ScopeSession):
		o.startRename()
		return none()
	case matchesInScope(kb, data, "app.session.delete", keybindings.ScopeSession):
		o.requestDelete()
		return none()
	case matchesInScope(kb, data, "app.session.deleteNoninvasive", keybindings.ScopeSession):
		// ctrl+backspace deletes only when the search query is empty.
		if o.input.Value() == "" {
			o.requestDelete()
		}
		return none()
	case matchesInScope(kb, data, "app.session.toggleSort", keybindings.ScopeSession):
		o.cycleSort()
		return none()
	case matchesInScope(kb, data, "app.session.togglePath", keybindings.ScopeSession):
		o.showPath = !o.showPath
		return none()
	case matchesInScope(kb, data, "app.session.toggleNamedFilter", keybindings.ScopeSession):
		o.toggleNamedFilter()
		return none()
	case matches(kb, data, "tui.select.up"):
		o.moveUp()
		return none()
	case matches(kb, data, "tui.select.down"):
		o.moveDown()
		return none()
	case matches(kb, data, "tui.select.confirm"):
		if s, ok := o.selected(); ok {
			return selectCmd("switch_session", map[string]any{"path": s.Path})
		}
		return none()
	case matches(kb, data, "tui.select.cancel"):
		return cancel(savedText)
	}
	if o.input.handleKey(data, kb) {
		o.recompute()
	}
	return none()
}

func (o *SessionPicker) handleRenameKey(data string, kb *keybindings.Manager) Outcome {
	switch {
	case matches(kb, data, "tui.select.confirm"):
		name := strings.TrimSpace(o.renameInput.Value())
		o.renaming = false
		s, ok := o.selected()
		if !ok {
			return none()
		}
		return selectCmd("set_session_name", map[string]any{"path": s.Path, "name": name})
	case matches(kb, data, "tui.select.cancel"):
		o.renaming = false
		return none()
	}
	o.renameInput.handleKey(data, kb)
	return none()
}

func (o *SessionPicker) startRename() {
	s, ok := o.selected()
	if !ok {
		return
	}
	o.renaming = true
	o.renameInput = newTextInput()
	o.renameInput.SetValue(s.Name)
}

// requestDelete enters confirmation mode, guarding the active session.
func (o *SessionPicker) requestDelete() {
	s, ok := o.selected()
	if !ok {
		return
	}
	if o.isActive(s.Path) {
		o.lastError = "Cannot delete the currently active session"
		return
	}
	o.confirmingDeletePath = s.Path
}

// isActive compares paths with symlink canonicalization (matching the classic
// selector treating symlink aliases of the active session as active).
func (o *SessionPicker) isActive(path string) bool {
	if o.activePath == "" {
		return false
	}
	return canonPath(path) == canonPath(o.activePath)
}

func canonPath(p string) string {
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return resolved
	}
	return filepath.Clean(p)
}

func (o *SessionPicker) cycleSort() {
	switch o.sortMode {
	case SortRecent:
		o.sortMode = SortRelevance
	case SortRelevance:
		o.sortMode = SortThreaded
	default:
		o.sortMode = SortRecent
	}
	o.recompute()
}

func (o *SessionPicker) toggleNamedFilter() {
	if o.nameFilter == NameFilterAll {
		o.nameFilter = NameFilterNamed
	} else {
		o.nameFilter = NameFilterAll
	}
	o.recompute()
}

func (o *SessionPicker) selected() (store.SessionInfo, bool) {
	if o.selectedIndex < 0 || o.selectedIndex >= len(o.visible) {
		return store.SessionInfo{}, false
	}
	return o.visible[o.selectedIndex], true
}

func (o *SessionPicker) moveUp() {
	if len(o.visible) == 0 {
		return
	}
	if o.selectedIndex == 0 {
		o.selectedIndex = len(o.visible) - 1
	} else {
		o.selectedIndex--
	}
}

func (o *SessionPicker) moveDown() {
	if len(o.visible) == 0 {
		return
	}
	if o.selectedIndex == len(o.visible)-1 {
		o.selectedIndex = 0
	} else {
		o.selectedIndex++
	}
}

// RenderPlain renders the picker without color for content assertions.
func (o *SessionPicker) RenderPlain(width int) []string { return o.render(width, false) }

// RenderStyled renders the picker with grok styling for the QA harness.
func (o *SessionPicker) RenderStyled(width int) []string { return o.render(width, true) }

func (o *SessionPicker) render(width int, styled bool) []string {
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

	title := "Resume Session (Current Folder)"
	lines = append(lines, style(o.th.AccentBlue, title))
	sortLabel := "sort: " + string(o.sortMode)
	filterLabel := "filter: " + string(o.nameFilter)
	lines = append(lines, style(o.th.TextMuted, sortLabel+"   "+filterLabel))
	if o.renaming {
		lines = append(lines, style(o.th.AccentYellow, "rename: "+o.renameInput.Value()))
	} else {
		lines = append(lines, "search: "+o.input.Value())
	}
	lines = append(lines, "")

	if len(o.visible) == 0 {
		lines = append(lines, style(o.th.TextMuted, "  No sessions"))
		lines = append(lines, border...)
		return lines
	}

	for i, s := range o.visible {
		isSelected := i == o.selectedIndex
		label := s.Name
		if label == "" {
			label = s.FirstMessage
		}
		prefix := "  "
		if isSelected {
			prefix = style(o.th.AccentBlue, "→ ")
			label = style(o.th.AccentBlue, label)
		}
		row := prefix + label
		if o.showPath {
			row += style(o.th.TextMuted, "  "+s.Path)
		}
		if o.confirmingDeletePath == s.Path {
			row += style(o.th.AccentRed, "  [delete? enter=yes esc=no]")
		}
		lines = append(lines, row)
	}
	if o.lastError != "" {
		lines = append(lines, style(o.th.AccentRed, "  "+o.lastError))
	}
	lines = append(lines, style(o.th.TextMuted, "  ("+strconv.Itoa(len(o.visible))+" sessions)"))
	if hint := o.renameHint(style); hint != "" {
		lines = append(lines, hint)
	}
	lines = append(lines, border...)
	return lines
}

// renameHint mirrors keyHint("app.session.rename", "rename") from the classic
// footer: the rename binding's key text (dim) followed by the "rename" label
// (muted), emitted only when ShowRenameHint is set. The key text is resolved
// LIVE from the keybinding registry so a user override is reflected and nothing
// is hardcoded.
func (o *SessionPicker) renameHint(style func(func() lipgloss.Style, string) string) string {
	if !o.showRenameHint {
		return ""
	}
	keys := o.kb.Keys("app.session.rename")
	if len(keys) == 0 {
		return ""
	}
	return style(o.th.TextMuted, "  ") + style(o.th.TextMuted, strings.Join(keys, "/")) + style(o.th.TextMuted, " rename")
}
