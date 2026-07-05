//go:build windows

package bridge

// On Windows the daemon transport uses named pipes via go-winio. This blank
// import anchors the dependency (retained by `go mod tidy`) and compiles only
// on Windows, where the concrete named-pipe Transport lands in a later task.
import _ "github.com/Microsoft/go-winio"
