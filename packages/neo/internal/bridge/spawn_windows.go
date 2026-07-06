//go:build windows

package bridge

import "syscall"

// detachedSysProcAttr starts the daemon in a new process group (Windows has no
// sessions) so a console Ctrl-C to the client does not propagate to the shared
// daemon. CREATE_NEW_PROCESS_GROUP + DETACHED_PROCESS keeps it off the client's
// console.
func detachedSysProcAttr() *syscall.SysProcAttr {
	const (
		createNewProcessGroup = 0x00000200
		detachedProcess       = 0x00000008
	)
	return &syscall.SysProcAttr{
		CreationFlags: createNewProcessGroup | detachedProcess,
	}
}
