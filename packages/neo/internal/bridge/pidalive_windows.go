//go:build windows

package bridge

import (
	"golang.org/x/sys/windows"
)

// IsPidAlive reports whether a process id is live on Windows. It opens the
// process with limited-query rights and checks its exit code: STILL_ACTIVE
// (259) means running. This is the Windows analogue of the signal-0 probe used
// on POSIX (isPidAlive in neo-daemon-registry.ts). A non-positive pid is dead.
func IsPidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// ERROR_INVALID_PARAMETER (no such pid) or access denied for a dead pid.
		return false
	}
	defer func() { _ = windows.CloseHandle(handle) }()

	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	const stillActive = 259 // STILL_ACTIVE
	return code == stillActive
}
