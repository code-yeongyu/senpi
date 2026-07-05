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
	for _, arg := range args {
		if arg == "--version" || arg == "-v" {
			fmt.Fprintln(out, versionBanner())
			return 0
		}
	}
	fmt.Fprintln(out, versionBanner())
	fmt.Fprintln(out, "senpi-neo: interactive TUI not yet implemented (scaffold)")
	return 0
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout))
}
