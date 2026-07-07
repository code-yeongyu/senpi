package app

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript"
)

// Action ids the Model resolves through the keybinding Manager. These are
// registry ids, not key strings — the Manager maps them to the resolved keys, so
// no raw key byte is ever compared against a literal here.
const (
	actionExit      = "app.exit"
	actionInterrupt = "app.interrupt"
	actionDequeue   = "app.message.dequeue"
)

// Frame fallbacks used before the first tea.WindowSizeMsg lands (and as a floor
// so the pre-turn welcome renders even with no size yet).
const (
	defaultWidth   = 80
	defaultHeight  = 24
	defaultAppName = "senpi"
)

// OverlayStack is the overlay-manager contract the frame consults. Todo 5
// implements it (internal/app/overlaystack.go); the skeleton holds it as an
// interface so an active modal can capture the frame and key input. A nil stack
// — this todo's default — means no overlay is ever active.
type OverlayStack interface {
	// Active reports whether a modal overlay is currently open and capturing the
	// frame + key input.
	Active() bool
	// Render draws the active overlay's frame lines at the terminal size. Only
	// called when Active reports true.
	Render(width, height int) []string
}

// AbortRequested is emitted when the user triggers app.interrupt. The session
// adapter (todo 2) consumes it to abort the in-flight turn; the skeleton only
// emits it, since there is no bridge to abort yet.
type AbortRequested struct{}

// Model is the neo TUI's root bubbletea model. It owns the theme, the keybinding
// manager, the shell region set, the editor, and the transcript feed, and
// composes them into one frame each render. Overlays (todo 5) and the bridge
// session (todo 2) attach through the fields/interface stubbed here.
type Model struct {
	theme    *theme.Theme
	keys     *keybindings.Manager
	shell    *shell.Shell
	editor   *editor.Editor
	feed     *transcript.Feed
	overlays OverlayStack

	width  int
	height int
}

// NewModel builds the root Model from its dependencies.
func NewModel(deps Deps) *Model {
	appName := deps.AppName
	if appName == "" {
		appName = defaultAppName
	}

	sh := shell.New(deps.Theme, firstKey(deps.Keys, actionDequeue), appName)
	welcome := deps.Welcome
	if welcome.Title == "" {
		welcome.Title = appName
	}
	if len(welcome.Menu) == 0 {
		welcome.Menu = []shell.MenuEntry{{Label: "Quit", Key: firstKey(deps.Keys, actionExit)}}
	}
	sh.SetWelcome(welcome)

	ed := editor.New(editor.Options{PaddingX: 1})
	ed.SetFocused(true)

	feed := transcript.NewFeed(transcript.NewRenderTheme(deps.Theme))
	feed.SetExpandHint(firstKey(deps.Keys, "app.tools.expand"))

	return &Model{
		theme:  deps.Theme,
		keys:   deps.Keys,
		shell:  sh,
		editor: ed,
		feed:   feed,
	}
}

// Init implements tea.Model. The skeleton needs no startup command; bubbletea
// delivers the initial tea.WindowSizeMsg on its own.
func (m *Model) Init() tea.Cmd { return nil }

// Update implements tea.Model.
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = v.Width, v.Height
		m.editor.SetViewport(v.Width, v.Height)
		return m, nil
	case tea.KeyboardEnhancementsMsg:
		// The terminal answered the KeyboardEnhancements request declared by the
		// View. When it supports key disambiguation, flip the matcher onto its
		// Kitty-protocol path so app chords resolve exactly as classic does.
		if v.SupportsKeyDisambiguation() {
			keybindings.SetKittyProtocolActive(true)
		}
		return m, nil
	case tea.KeyPressMsg:
		return m.handleKey(v)
	case tea.PasteMsg:
		m.editor.Update(msg)
		return m, nil
	}
	return m, nil
}

// handleKey routes a key press. App-level chords (interrupt, exit) resolve
// through the Manager first; everything else is forwarded to the focused editor.
func (m *Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	raw := editor.KeyToRaw(tea.Key(msg))

	// app.interrupt aborts the in-flight turn (todo 2 consumes AbortRequested).
	if m.keys.Matches(raw, actionInterrupt) {
		return m, emitAbort
	}
	// app.exit quits, but only when the editor is empty — matching the classic
	// ctrl+d-on-empty semantics (a non-empty editor keeps ctrl+d for the editor's
	// own delete-forward binding).
	if m.keys.Matches(raw, actionExit) && m.editor.GetText() == "" {
		return m, tea.Quit
	}

	m.editor.Update(msg)
	return m, nil
}

// emitAbort is the tea.Cmd that publishes an AbortRequested message.
func emitAbort() tea.Msg { return AbortRequested{} }

// View implements tea.Model, composing the frame per the shell region order
// (shell/shell.go): welcome header, transcript, above-editor regions, the editor
// itself, below-editor regions, then a hint line. When an overlay is active it
// captures the whole frame instead.
func (m *Model) View() tea.View {
	width, height := m.frameSize()

	if m.overlays != nil && m.overlays.Active() {
		return m.newView(strings.Join(m.overlays.Render(width, height), "\n"), nil)
	}

	var lines []string
	lines = append(lines, m.shell.Header(width)...)      // welcome (pre-first-turn only)
	lines = append(lines, m.feed.Render(width)...)       // transcript
	lines = append(lines, m.shell.AboveEditor(width)...) // widgets + status + pending

	editorOriginY := len(lines)
	editorRows := m.editor.Render(width)
	for _, row := range editorRows {
		lines = append(lines, editor.StripCursorMarker(row))
	}

	lines = append(lines, m.shell.BelowEditor(width)...) // widgets + footer
	lines = append(lines, m.hintLine(width))             // shortcut hint line

	cursor := m.editor.ViewCursor(editorRows, 0, editorOriginY)
	return m.newView(strings.Join(lines, "\n"), cursor)
}

// newView wraps content in a tea.View, requesting keyboard enhancements via the
// View field (bubbletea v2 has no program option for this) and NOT enabling the
// alternate screen. Basic key disambiguation is on by default; requesting
// alternate keys lets chords like shift+enter disambiguate when supported.
func (m *Model) newView(content string, cursor *tea.Cursor) tea.View {
	v := tea.NewView(content)
	v.KeyboardEnhancements.ReportAlternateKeys = true
	if cursor != nil {
		v.Cursor = cursor
	}
	return v
}

// hintLine renders the bottom shortcut hint, resolving every key display through
// the Manager (no literal key strings), and truncates it to the frame width.
func (m *Model) hintLine(width int) string {
	var parts []string
	if k := firstKey(m.keys, actionInterrupt); k != "" {
		parts = append(parts, k+" interrupt")
	}
	if k := firstKey(m.keys, actionExit); k != "" {
		parts = append(parts, k+" exit")
	}
	hint := ui.TruncateToWidth(strings.Join(parts, "  ·  "), width, "")
	return m.theme.Hint().Render(hint)
}

// frameSize returns the render size, falling back to the default floor before
// the first tea.WindowSizeMsg (and guarding against non-positive dimensions).
func (m *Model) frameSize() (width, height int) {
	width, height = m.width, m.height
	if width <= 0 {
		width = defaultWidth
	}
	if height <= 0 {
		height = defaultHeight
	}
	return width, height
}

// SetOverlays installs the overlay stack (todo 5). Kept as a setter so the
// skeleton's constructor stays free of the not-yet-built overlay manager.
func (m *Model) SetOverlays(o OverlayStack) { m.overlays = o }

// firstKey returns the first resolved key display for an action, or "" when the
// action is unbound.
func firstKey(m *keybindings.Manager, action string) string {
	keys := m.Keys(action)
	if len(keys) == 0 {
		return ""
	}
	return keys[0]
}
