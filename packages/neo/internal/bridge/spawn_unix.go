//go:build !windows

package bridge

import "syscall"

// detachedSysProcAttr starts the daemon in its own session (Setsid) so it is
// fully detached from the client's controlling terminal and process group — a
// Ctrl-C to the client never reaches the shared daemon.
func detachedSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
