//go:build !windows

package bridge

import (
	"errors"
	"syscall"
)

// IsPidAlive reports whether a process id is live. It mirrors isPidAlive in
// neo-daemon-registry.ts: signal 0 probes the process — ESRCH means the pid is
// dead, EPERM means it is alive but not signalable by us (still "alive"). A
// non-positive pid is always dead.
func IsPidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}
