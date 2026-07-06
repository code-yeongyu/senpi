//go:build windows

package bridge

import "os"

// sigTerm on Windows falls back to os.Kill: Windows has no SIGTERM delivery for
// arbitrary processes, so Close() terminates the child directly.
func sigTerm() os.Signal { return os.Kill }
