// Command senpi-neo is the Go-native terminal UI for senpi.
//
// It drives the TypeScript agent brain over senpi's JSONL RPC protocol: it parses
// the forwarded neo argv, resolves the agent dir + theme + keybindings, connects
// the transport (daemon attach-or-spawn, or a single-child isolated backend), and
// runs the interactive bubbletea program, propagating its exit code to the
// launcher. The build stamps the version via -ldflags "-X main.version=<v>";
// absent a stamp it reports the development banner.
package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// appName is the welcome-card label and terminal-title app name.
const appName = "senpi"

// neoCapabilities are the client capability opt-ins forwarded in the daemon
// handshake. custom_unsupported makes ctx.ui.custom surface the additive notice
// rather than silently resolving undefined.
var neoCapabilities = []string{"custom_unsupported"}

// modulePath is the Go module path, echoed in the dev version banner so the
// banner unambiguously identifies which build produced it.
const modulePath = "github.com/code-yeongyu/senpi/packages/neo"

// version is overridden at link time with -ldflags "-X main.version=<v>".
var version = "dev"

// versionBanner composes the string printed for `--version`.
func versionBanner() string {
	return fmt.Sprintf("senpi-neo %s (%s)", version, modulePath)
}

// run parses args and writes output, returning the process exit code. It takes
// the args (without the program name) and an output writer so it is testable.
func run(args []string, out io.Writer) int {
	for i, arg := range args {
		if arg == "--version" || arg == "-v" {
			fmt.Fprintln(out, versionBanner())
			return 0
		}
		// --theme-sample [profile] renders the grok theme's sample panel. It is
		// a hidden QA/evidence surface (not the interactive TUI) used by the
		// task-2 xterm.js harness triplets and tmux manual QA; it changes no
		// existing print/RPC behavior.
		if arg == "--theme-sample" {
			profileName := ""
			if i+1 < len(args) {
				profileName = args[i+1]
			}
			return runThemeSample(profileName, out)
		}
	}
	return launch(args, out)
}

// launch resolves the runtime environment, connects the transport, and runs the
// interactive program, returning the process exit code the launcher re-raises.
// Any setup failure is reported as a single actionable stderr line + exit 1
// (packages/coding-agent/src/cli/neo/launch.ts adopts the child's code verbatim).
func launch(args []string, _ io.Writer) int {
	cfg := store.DefaultConfig()
	agentDir := cfg.AgentDir()

	cwd, err := os.Getwd()
	if err != nil {
		return fail("cannot resolve the working directory: " + err.Error())
	}

	settings, _ := store.LoadSettings(cwd, agentDir)
	th, err := theme.Load(theme.Options{Name: settings.EffectiveNeoTheme(), AgentDir: agentDir})
	if err != nil {
		return fail("theme load failed: " + err.Error())
	}
	keys, err := keybindings.Load(agentDir)
	if err != nil {
		// Keybindings never block launch: fall back to the built-in defaults.
		keys = keybindings.NewManager(nil)
	}

	result, err := bridge.Connect(bridge.ConnectConfig{
		NeoArgv:      args,
		GOOS:         runtime.GOOS,
		AgentDir:     agentDir,
		Cwd:          cwd,
		Capabilities: neoCapabilities,
	})
	if err != nil {
		return fail("could not start the senpi backend: " + connectHint(err))
	}
	defer func() { _ = result.Close() }()

	client := bridge.NewClient(result.Transport)
	prog := app.BuildInteractiveProgram(app.InteractiveConfig{
		Theme:        th,
		Keys:         keys,
		AppName:      appName,
		Cwd:          cwd,
		Home:         homeDir(),
		AgentDir:     agentDir,
		GitBranch:    readGitBranch(cwd),
		Themes:       availableThemeNames(agentDir),
		CurrentTheme: settings.EffectiveNeoTheme(),
		Client:       client,
		Result:       result,
		Capabilities: neoCapabilities,
	})

	final, err := prog.Run()
	if err != nil {
		return fail("interactive session ended with an error: " + singleLine(err.Error()))
	}
	if m, ok := final.(*app.Model); ok {
		return m.ExitCode()
	}
	return 0
}

// fail writes one actionable line to stderr and returns exit code 1.
func fail(msg string) int {
	fmt.Fprintln(os.Stderr, "senpi-neo: "+msg)
	return 1
}

// singleLine collapses a (possibly multi-line, stderr-laden) error into one line
// so a connect failure is a single actionable diagnostic, never a block.
func singleLine(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.Join(strings.Fields(s), " ")
}

// connectHint reduces a connect error to one actionable line: the captured child
// stderr (which carries the backend's own stack trace) is dropped, and the result
// is bounded so the launcher surfaces a diagnostic, never a wall of node output.
func connectHint(err error) string {
	msg := singleLine(err.Error())
	if i := strings.Index(msg, "; stderr:"); i >= 0 {
		msg = strings.TrimSpace(msg[:i])
	}
	const max = 200
	if len(msg) > max {
		msg = msg[:max] + "…"
	}
	return msg
}

// homeDir returns the user home for the footer's ~-relativized cwd (best-effort).
func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return os.Getenv("HOME")
}

// readGitBranch reads <cwd>/.git/HEAD for a display-only branch label. A detached
// HEAD, a worktree gitlink file, or a missing repo yields "" (no label). Watching
// .git for changes belongs to a later environment layer; this is a one-shot read.
func readGitBranch(cwd string) string {
	data, err := os.ReadFile(filepath.Join(cwd, ".git", "HEAD"))
	if err != nil {
		return ""
	}
	if rest, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "ref: refs/heads/"); ok {
		return rest
	}
	return ""
}

// availableThemeNames lists the theme names the settings/theme overlays offer:
// the default skin plus every custom theme on disk (builtin palettes beyond the
// default are not yet enumerated by the theme package).
func availableThemeNames(agentDir string) []string {
	names := []string{theme.DefaultThemeName}
	custom, _ := store.ListCustomThemes(agentDir)
	for _, c := range custom {
		names = append(names, c.Name)
	}
	return names
}

// runThemeSample loads the default neo theme and renders its sample panel at the
// requested color profile (default: truecolor). Unknown profiles are reported.
func runThemeSample(profileName string, out io.Writer) int {
	th, err := theme.Load(theme.Options{})
	if err != nil {
		fmt.Fprintln(os.Stderr, "senpi-neo: theme load failed:", err)
		return 1
	}
	profile, err := theme.ProfileFromName(profileName)
	if err != nil {
		fmt.Fprintln(os.Stderr, "senpi-neo:", err)
		return 2
	}
	fmt.Fprint(out, th.SamplePanel(profile))
	return 0
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout))
}
