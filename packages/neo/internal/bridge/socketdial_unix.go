//go:build !windows

package bridge

import (
	"net"
	"time"
)

// dialNeoSocket connects to the daemon's unix domain socket. The task-15 daemon
// binds a unix socket on POSIX (createServer().listen(path)); the client dials
// the same path.
func dialNeoSocket(path string, timeout time.Duration) (net.Conn, error) {
	d := net.Dialer{Timeout: timeout}
	return d.Dial("unix", path)
}
