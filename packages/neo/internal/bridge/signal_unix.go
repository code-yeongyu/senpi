//go:build !windows

package bridge

import (
	"os"
	"syscall"
)

// sigTerm is SIGTERM on POSIX so the RPC child gets a chance to shut down
// gracefully (rpc-client.ts stop() sends SIGTERM, then SIGKILL after 1s).
func sigTerm() os.Signal { return syscall.SIGTERM }
