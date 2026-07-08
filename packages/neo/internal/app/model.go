package app

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash"
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
// implements it (internal/app/overlaystack.go, *Manager); the Model holds it as
// an interface so an active modal can capture the frame and key input. A nil
// stack means no overlay is ever active.
type OverlayStack interface {
	// Active reports whether a modal overlay is currently open and capturing the
	// frame + key input.
	Active() bool
	// Render draws the active overlay's frame lines at the terminal size. Only
	// called when Active reports true.
	Render(width, height int) []string
	// HandleKey routes a raw key through the overlay stack: to the active overlay
	// when one is open (scope-switched via the keybinding Manager contexts), or to
	// the overlay-launching editor-scope chords when inactive. The result tells
	// the Model whether the key was consumed, what command to run, and whether to
	// restore the saved editor text after an overlay closed.
	HandleKey(raw string) OverlayKeyResult
}

// AbortRequested is emitted when the user triggers app.interrupt. The session
// adapter (todo 2) consumes it to abort the in-flight turn; the skeleton only
// emits it, since there is no bridge to abort yet.
type AbortRequested struct{}

// Model is the neo TUI's root bubbletea model. It owns the theme, the keybinding
// manager, the shell region set, the editor, and the transcript feed, and
// composes them into one frame each render. The interactive assembly (assemble.go)
// attaches the live bridge collaborators (session, transcript translator, shell
// wire, input router, overlay stack, recovery); the presentational welcome scene
// (NewModel + NewProgram) leaves them nil and every route is nil-safe.
type Model struct {
	theme    *theme.Theme
	keys     *keybindings.Manager
	shell    *shell.Shell
	editor   *editor.Editor
	feed     *transcript.Feed
	overlays OverlayStack

	// Interactive collaborators — nil in the presentational welcome scene.
	ref       *clientRef // live client + session adapter (swapped on recovery)
	program   programSender
	xscript   *Transcript
	wire      *ShellWire
	recovery  *Recovery
	router    *Router
	extui     *ExtUI
	requester *overlayRequester
	opts      bridge.NeoRuntimeOptions

	// Overlay open-on-response context + local-overlay build state.
	pendingOverlay OverlayKind
	overlayCtx     overlayBuildContext
	// pendingFollow is the composite post-step (clipboard/gist/import) a routed
	// RPC (/copy, /share, /import) runs when its response lands.
	pendingFollow slash.NativeKind

	// submits collects editor OnSubmit lines during a single key handling so the
	// route step can classify them off the editor's synchronous callback.
	submits []string

	// initialInputsSent guards the launch-input delivery so a recovery re-bootstrap
	// never re-sends the initial prompt.
	initialInputsSent bool
	exitCode          int

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

// Init implements tea.Model. The presentational scene needs no startup command;
// the interactive assembly overrides this via initCmd so Bootstrap fans out on
// launch (assemble.go binds it before Run).
func (m *Model) Init() tea.Cmd {
	if m.ref == nil {
		return nil
	}
	_, session := m.ref.get()
	if session == nil {
		return nil
	}
	// Bootstrap first; InitialInputs is deferred to the BootstrapMsg handler so the
	// launch prompt lands after the session snapshot (plan todo 9 ordering).
	return session.Bootstrap()
}

// The interactive Update loop, key routing, and message handlers live in route.go.

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
	lines = append(lines, m.shell.Header(width)...) // welcome (pre-first-turn only)
	lines = append(lines, m.feed.Render(width)...)  // transcript
	if bash := m.bashLines(width); len(bash) > 0 {
		lines = append(lines, bash...) // `!`-command block (idle placement)
	}
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
// alternate keys lets chords like shift+enter disambiguate when supported. The
// window title is the shell wire's readable title (plain text — bubbletea owns
// the OSC escape); the presentational scene leaves it unset.
func (m *Model) newView(content string, cursor *tea.Cursor) tea.View {
	v := tea.NewView(content)
	v.KeyboardEnhancements.ReportAlternateKeys = true
	if m.wire != nil {
		v.WindowTitle = m.wire.WindowTitle()
	}
	if cursor != nil {
		v.Cursor = cursor
	}
	return v
}

// bashLines renders the router's most recent `!`-command block (nil before any
// bash command, or in the presentational scene).
func (m *Model) bashLines(width int) []string {
	if m.router == nil {
		return nil
	}
	if b := m.router.BashBlock(); b != nil {
		return b.Render(width)
	}
	return nil
}

// ExitCode reports the process exit code the launcher should re-raise. It is 0
// for a clean quit and set to the recovery loop's fatal code (1) when the backend
// exited unrecoverably.
func (m *Model) ExitCode() int { return m.exitCode }

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
