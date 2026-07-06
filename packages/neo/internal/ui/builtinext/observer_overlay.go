package builtinext

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

const hudMaxVisibleSessions = 12

// SessionHudOptions configures a SessionHudOverlay.
type SessionHudOptions struct {
	Sessions      []SessionHudEntry
	Theme         *theme.Theme
	Keybindings   *keybindings.Manager
	Done          func()
	RequestRender func()
	// ViewportRows overrides the transcript viewport height (default 12). The app
	// shell threads the real terminal height here; tests use the default.
	ViewportRows int
}

// SessionHudOverlay is the native port of session-observer/overlay.ts: a session
// picker that opens a scrollable transcript viewer. The viewer tails the loaded
// snapshot; navigation (j/k/g/G/pageUp/pageDown), expand (enter), back-to-picker
// (esc), and close (the observe keybinding) mirror the classic HUD.
type SessionHudOverlay struct {
	opts            SessionHudOptions
	roles           roleStyler
	pickerList      *ui.SelectList
	sessionsByValue map[string]SessionHudEntry

	mode                   string // "picker" | "viewer"
	selectedSession        *SessionHudEntry
	snapshot               *TranscriptSnapshot
	tail                   *SessionTail
	renderedLines          []string
	ranges                 []ViewerEntryRange
	selectedEntry          int
	shouldSelectLastOnLoad bool
	expanded               map[int]bool
	scrollOffset           int
	viewportHeight         int
	loadingText            string

	topBorder    *ui.DynamicBorder
	middleBorder *ui.DynamicBorder
	bottomBorder *ui.DynamicBorder
}

// NewSessionHudOverlay builds the HUD overlay in picker mode.
func NewSessionHudOverlay(opts SessionHudOptions) *SessionHudOverlay {
	accent := func(s string) string { return newRoleStyler(opts.Theme).fg("accent", s) }
	vp := opts.ViewportRows
	if vp <= 0 {
		vp = 12
	}
	ov := &SessionHudOverlay{
		opts:            opts,
		roles:           newRoleStyler(opts.Theme),
		sessionsByValue: map[string]SessionHudEntry{},
		mode:            "picker",
		selectedEntry:   -1,
		expanded:        map[int]bool{},
		viewportHeight:  vp,
		topBorder:       ui.NewDynamicBorderColored(accent),
		middleBorder:    ui.NewDynamicBorderColored(accent),
		bottomBorder:    ui.NewDynamicBorderColored(accent),
	}
	ov.rebuildPicker()
	return ov
}

// Mode returns the current overlay mode ("picker" | "viewer").
func (o *SessionHudOverlay) Mode() string { return o.mode }

// SelectedEntryIndex returns the viewer's selected entry index (-1 in picker).
func (o *SessionHudOverlay) SelectedEntryIndex() int { return o.selectedEntry }

// ExpandedEntryCount returns the number of expanded viewer entries.
func (o *SessionHudOverlay) ExpandedEntryCount() int { return len(o.expanded) }

// HandleInput dispatches to the picker or viewer handler.
func (o *SessionHudOverlay) HandleInput(input string) {
	if o.mode == "picker" {
		o.handlePickerInput(input)
		return
	}
	o.handleViewerInput(input)
}

// Render renders the active mode.
func (o *SessionHudOverlay) Render(width int) []string {
	if o.mode == "picker" {
		return o.renderPicker(width)
	}
	return o.renderViewer(width)
}

// --- picker -----------------------------------------------------------------

func (o *SessionHudOverlay) rebuildPicker() {
	o.sessionsByValue = map[string]SessionHudEntry{}
	items := make([]ui.SelectItem, len(o.opts.Sessions))
	for i, s := range o.opts.Sessions {
		value := itoa(i)
		o.sessionsByValue[value] = s
		items[i] = ui.SelectItem{Value: value, Label: pickerLabel(s), Description: describeSession(s)}
	}
	maxVisible := min(hudMaxVisibleSessions, len(items))
	if maxVisible < 1 {
		maxVisible = 1
	}
	r := o.roles
	o.pickerList = ui.NewSelectList(items, maxVisible, ui.SelectListTheme{
		SelectedPrefix: func(s string) string { return r.fg("accent", s) },
		SelectedText:   func(s string) string { return s },
		Description:    func(s string) string { return r.fg("muted", s) },
		ScrollInfo:     func(s string) string { return r.fg("dim", s) },
		NoMatch:        func(s string) string { return r.fg("warning", strings.ReplaceAll(s, "commands", "sessions")) },
	}, ui.SelectListLayout{})
}

func (o *SessionHudOverlay) handlePickerInput(input string) {
	km := o.opts.Keybindings
	switch {
	case km.Matches(input, "tui.select.up"):
		o.pickerList.MoveUp()
	case km.Matches(input, "tui.select.down"):
		o.pickerList.MoveDown()
	case km.Matches(input, "tui.select.confirm"):
		if item, ok := o.pickerList.SelectedItem(); ok {
			if s, exists := o.sessionsByValue[item.Value]; exists {
				o.openSession(s)
			}
		}
	case km.Matches(input, "tui.select.cancel"):
		if o.opts.Done != nil {
			o.opts.Done()
		}
	}
}

func (o *SessionHudOverlay) renderPicker(width int) []string {
	r := o.roles
	lines := []string{}
	heading := r.boldText(r.fg("accent", " Sessions")) + r.fg("dim", " "+itoa(len(o.opts.Sessions))+" sessions")
	lines = append(lines, heading)
	lines = append(lines, "")
	lines = append(lines, o.pickerList.Render(width)...)
	lines = append(lines, "")
	lines = append(lines, ui.NewTruncatedText(
		keyHint(o.opts.Keybindings, "tui.select.confirm", "view")+" "+keyHint(o.opts.Keybindings, "tui.select.cancel", "close"),
		0, 0,
	).Render(width)...)
	return lines
}

func pickerLabel(s SessionHudEntry) string {
	label := compactWhitespace(s.LastUserText)
	if label == "" {
		return "(no user prompt)"
	}
	return label
}

func describeSession(s SessionHudEntry) string {
	cwd := shortenPath(s.CWD)
	if cwd == "" {
		cwd = "unknown"
	}
	return cwd + " · " + sessionAge(s) + " · " + itoa(s.MessageCount) + " msg"
}

func sessionAge(s SessionHudEntry) string {
	if s.IsCurrent {
		return "live"
	}
	return formatSessionDate(s.ModifiedAt)
}

// The viewer mode (openSession, Refresh, transcript rebuild/scroll, renderViewer,
// handleViewerInput, and helpers) lives in observer_viewer.go.
