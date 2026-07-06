// Command senpi-neo is the Go-native terminal UI for senpi.
//
// It drives the TypeScript agent brain over senpi's JSONL RPC protocol; this
// entrypoint is a scaffold that will grow the full interactive TUI. The build
// stamps the version via -ldflags "-X main.version=<v>"; absent a stamp it
// reports the development banner.
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

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
	fmt.Fprintln(out, versionBanner())
	fmt.Fprintln(out, "senpi-neo: interactive TUI not yet implemented (scaffold)")
	return 0
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
