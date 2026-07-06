package builtinext

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// observer_viewer.go holds the SessionHudOverlay's viewer mode: opening a
// session, the live tail Refresh, transcript rebuild + scroll, viewer rendering,
// and viewer input. Split from observer_overlay.go (which keeps the picker) to
// stay within the pure-LOC ceiling. Ported from session-observer/overlay.ts.

func (o *SessionHudOverlay) openSession(s SessionHudEntry) {
	o.mode = "viewer"
	sc := s
	o.selectedSession = &sc
	o.snapshot = nil
	o.resetViewerState()
	// Load synchronously (Go has no async ui.custom promise; the classic
	// overlay's async load is a UX affordance, not a semantic one).
	o.tail = NewSessionTail(s.Path)
	snap, err := o.tail.Load()
	if err != nil {
		o.loadingText = "Failed to read session: " + err.Error()
	} else {
		o.snapshot = &snap
		o.loadingText = ""
	}
	o.rebuildTranscript(80)
	if o.opts.RequestRender != nil {
		o.opts.RequestRender()
	}
}

// Refresh re-reads the tailed session file and rebuilds the transcript. The app
// shell calls this on a timer (or fs event) so the observer follows a growing
// session. It is a no-op in picker mode.
func (o *SessionHudOverlay) Refresh(width int) {
	if o.mode != "viewer" || o.tail == nil {
		return
	}
	snap, err := o.tail.Load()
	if err != nil {
		o.loadingText = "Failed to read session: " + err.Error()
		return
	}
	o.snapshot = &snap
	o.loadingText = ""
	o.rebuildTranscript(width)
}

func (o *SessionHudOverlay) resetViewerState() {
	o.expanded = map[int]bool{}
	o.scrollOffset = 0
	o.selectedEntry = -1
	o.shouldSelectLastOnLoad = true
	o.renderedLines = nil
	o.ranges = nil
}

func (o *SessionHudOverlay) rebuildTranscript(width int) {
	if o.snapshot == nil {
		return
	}
	rendered := RenderTranscript(o.snapshot.Entries, TranscriptRenderOptions{
		Width:           width,
		SelectedIndex:   o.selectedEntry,
		ExpandedEntries: o.expanded,
		Theme:           o.opts.Theme,
	})
	o.renderedLines = rendered.Lines
	o.ranges = rendered.Ranges
	if len(o.ranges) > 0 && o.shouldSelectLastOnLoad {
		o.shouldSelectLastOnLoad = false
		o.selectedEntry = len(o.ranges) - 1
		o.rebuildTranscript(width)
		return
	}
	o.scrollToSelected()
}

func (o *SessionHudOverlay) renderViewer(width int) []string {
	o.rebuildTranscript(width)
	r := o.roles
	title := "Sessions"
	if o.selectedSession != nil {
		cwd := shortenPath(o.selectedSession.CWD)
		if cwd == "" {
			cwd = "unknown"
		}
		title = "Sessions > " + cwd + " · " + o.selectedSession.ShortID
	}
	status := ""
	if o.selectedSession != nil {
		status = itoa(o.selectedSession.MessageCount) + " messages · " + sessionAge(*o.selectedSession)
		if o.snapshot != nil && o.snapshot.Model != "" {
			status += " · " + o.snapshot.Model
		}
	}
	content := o.renderedLines
	if o.loadingText != "" {
		content = []string{r.fg("dim", o.loadingText)}
	}
	maxScroll := max(0, len(content)-o.viewportHeight)
	if o.scrollOffset > maxScroll {
		o.scrollOffset = maxScroll
	}
	if o.scrollOffset < 0 {
		o.scrollOffset = 0
	}
	visible := content[o.scrollOffset:min(o.scrollOffset+o.viewportHeight, len(content))]

	lines := []string{}
	lines = append(lines, o.topBorder.Render(width)...)
	lines = append(lines, renderLine(" "+r.boldText(r.fg("accent", title)), width))
	if status != "" {
		lines = append(lines, renderLine(" "+r.fg("dim", status), width))
	}
	lines = append(lines, o.middleBorder.Render(width)...)
	for _, line := range visible {
		lines = append(lines, " "+sanitizeLine(line, width-2))
	}
	for i := len(visible); i < o.viewportHeight; i++ {
		lines = append(lines, "")
	}
	scroll := ""
	if len(content) > o.viewportHeight {
		scroll = " [" + itoa(o.scrollOffset+1) + "-" + itoa(min(o.scrollOffset+o.viewportHeight, len(content))) + "/" + itoa(len(content)) + "]"
	}
	lines = append(lines, renderLine(" "+o.viewerFooter(scroll), width))
	lines = append(lines, o.bottomBorder.Render(width)...)
	return lines
}

func (o *SessionHudOverlay) handleViewerInput(input string) {
	km := o.opts.Keybindings
	switch {
	case km.Matches(input, "app.sessions.observe"):
		if o.opts.Done != nil {
			o.opts.Done()
		}
		return
	case km.Matches(input, "tui.select.cancel"):
		o.backToPicker()
	case input == "j" || km.Matches(input, "tui.select.down"):
		o.moveSelection(1)
	case input == "k" || km.Matches(input, "tui.select.up"):
		o.moveSelection(-1)
	case km.Matches(input, "tui.select.pageDown"):
		o.moveSelection(5)
	case km.Matches(input, "tui.select.pageUp"):
		o.moveSelection(-5)
	case input == "g":
		o.jumpTo(0)
	case input == "G":
		o.jumpTo(len(o.ranges) - 1)
	case km.Matches(input, "tui.select.confirm"):
		o.toggleExpanded()
	}
	if o.opts.RequestRender != nil {
		o.opts.RequestRender()
	}
}

func (o *SessionHudOverlay) backToPicker() {
	o.mode = "picker"
	o.rebuildPicker()
}

func (o *SessionHudOverlay) moveSelection(delta int) {
	if len(o.ranges) == 0 {
		return
	}
	o.selectedEntry = clamp(o.selectedEntry+delta, 0, len(o.ranges)-1)
	o.scrollToSelected()
}

func (o *SessionHudOverlay) jumpTo(index int) {
	if len(o.ranges) == 0 {
		return
	}
	o.selectedEntry = clamp(index, 0, len(o.ranges)-1)
	o.scrollToSelected()
}

func (o *SessionHudOverlay) toggleExpanded() {
	if len(o.ranges) == 0 {
		return
	}
	if o.expanded[o.selectedEntry] {
		delete(o.expanded, o.selectedEntry)
	} else {
		o.expanded[o.selectedEntry] = true
	}
}

func (o *SessionHudOverlay) scrollToSelected() {
	if o.selectedEntry < 0 || o.selectedEntry >= len(o.ranges) {
		return
	}
	sel := o.ranges[o.selectedEntry]
	bottom := sel.LineStart + sel.LineCount
	if sel.LineStart < o.scrollOffset {
		o.scrollOffset = max(0, sel.LineStart-1)
	}
	if bottom > o.scrollOffset+o.viewportHeight {
		o.scrollOffset = max(0, bottom-o.viewportHeight+1)
	}
}

func (o *SessionHudOverlay) viewerFooter(scroll string) string {
	r := o.roles
	scrollKeys := r.fg("dim", keyText(o.opts.Keybindings, "tui.select.up")+"/"+keyText(o.opts.Keybindings, "tui.select.down")) + r.fg("muted", " scroll")
	sep := r.fg("muted", " · ")
	joined := strings.Join([]string{
		scrollKeys,
		keyHint(o.opts.Keybindings, "tui.select.confirm", "expand"),
		keyHint(o.opts.Keybindings, "tui.select.cancel", "sessions"),
		keyHint(o.opts.Keybindings, "app.sessions.observe", "close"),
	}, sep)
	return joined + scroll
}

// renderLine mirrors overlay-format.ts renderLine: a single TruncatedText line.
func renderLine(text string, width int) string {
	lines := ui.NewTruncatedText(text, 0, 0).Render(width)
	if len(lines) == 0 {
		return ""
	}
	return lines[0]
}
