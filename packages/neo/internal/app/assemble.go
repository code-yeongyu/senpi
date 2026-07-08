package app

import (
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/extui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript"
)

// InteractiveConfig carries the resolved launch environment the assembly wires
// the live TUI from: the connected client + its transport metadata, the loaded
// theme/keybindings, and the display-only environment facts.
type InteractiveConfig struct {
	Theme        *theme.Theme
	Keys         *keybindings.Manager
	AppName      string
	Cwd          string
	Home         string
	AgentDir     string
	GitBranch    string
	Themes       []string // available theme names for the settings/theme overlays
	CurrentTheme string
	Client       *bridge.Client
	Result       *bridge.ConnectResult
	Capabilities []string
	Timeout      time.Duration
}

// BuildInteractiveProgram assembles the whole neo TUI over a live bridge client
// and returns the runnable program. It wires every wave-3 collaborator through a
// swap-safe client ref (so daemon recovery re-points them all), binds the session
// pump after the program exists, and returns the *tea.Program whose final Model
// carries the process exit code.
func BuildInteractiveProgram(cfg InteractiveConfig) *tea.Program {
	appName := cfg.AppName
	if appName == "" {
		appName = defaultAppName
	}
	th, keys := cfg.Theme, cfg.Keys

	// Presentational base.
	sh := shell.New(th, firstKey(keys, actionDequeue), appName)
	sh.SetWelcome(defaultWelcome(keys, appName))
	ed := editor.New(editor.Options{PaddingX: 1})
	ed.SetFocused(true)
	feed := transcript.NewFeed(transcript.NewRenderTheme(th))
	feed.SetExpandHint(firstKey(keys, actionToolsExpand))

	// Swap-safe client + deferred program sender.
	ref := &clientRef{}
	holder := &programHolder{}

	// Event translators + shell wire (footer/title/status).
	xscript := NewTranscript(feed, keys)
	wire := NewShellWire(sh, ShellWireConfig{
		Theme:     th,
		Keys:      keys,
		Stats:     refStats{ref: ref},
		AppName:   appName,
		Cwd:       cfg.Cwd,
		Home:      cfg.Home,
		GitBranch: cfg.GitBranch,
	})

	// Input router over the slash dispatcher and the shared shell queue.
	router := NewRouter(slash.NewDispatcher(slash.NewBuiltins()), sh.Queue(), refCommander{ref: ref}, th)
	router.AttachEditor(ed)

	// Overlay manager + native requester + extension-UI controller (installed as
	// the Model's overlay stack, not the bare manager).
	requester := &overlayRequester{ref: ref, agentDir: cfg.AgentDir, cwd: cfg.Cwd}
	mgr := NewManager(keys, requester)
	sink := directiveSink{wire: wire, editor: ed, feed: feed}
	extctl := NewExtUI(extui.Deps{Theme: th, Keybindings: keys}, mgr, refDoer{ref: ref}, refResponder{ref: ref}, sink)

	// Bounded recovery (daemon reconnect/respawn; isolated child-exit is fatal).
	rc := RecoveryConfig{Mode: cfg.Result.Mode, Replay: feedReplayer{feed: feed, program: holder}}
	if cfg.Result.Mode == bridge.TransportDaemon && cfg.Result.Daemon != nil {
		rc.Reattach = DaemonReattach(cfg.Result.Daemon, cfg.Capabilities, cfg.Result.Options, cfg.Timeout)
	}
	rec := NewRecovery(rc)

	m := &Model{
		theme:     th,
		keys:      keys,
		shell:     sh,
		editor:    ed,
		feed:      feed,
		ref:       ref,
		program:   holder,
		xscript:   xscript,
		wire:      wire,
		recovery:  rec,
		router:    router,
		extui:     extctl,
		requester: requester,
		opts:      cfg.Result.Options,
		overlayCtx: overlayBuildContext{
			themes:       cfg.Themes,
			currentTheme: cfg.CurrentTheme,
		},
	}
	m.SetOverlays(extctl)
	// Editor submissions are stashed on the Model and classified on the next drain,
	// off the editor's synchronous OnSubmit callback.
	ed.OnSubmit = func(text string) { m.submits = append(m.submits, text) }

	prog := tea.NewProgram(m)
	holder.set(prog)
	// Bind the session over the live client + program AFTER the program exists so
	// the pump forwards straight into the running update loop.
	ref.set(cfg.Client, NewSession(cfg.Client, holder, cfg.Result.Options))
	return prog
}

// defaultWelcome builds the startup card, resolving every menu key through the
// keybinding manager (no literal key strings).
func defaultWelcome(keys *keybindings.Manager, appName string) shell.WelcomeContent {
	return shell.WelcomeContent{
		Title: appName,
		Menu: []shell.MenuEntry{
			{Label: "Resume session", Key: firstKey(keys, "app.sessions.observe")},
			{Label: "Search history", Key: firstKey(keys, "app.history.search")},
			{Label: "Quit", Key: firstKey(keys, actionExit)},
		},
	}
}
