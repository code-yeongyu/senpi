//go:build windows

package bridge

import (
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

// dialNeoSocket connects to the daemon's named pipe on Windows via go-winio.
// Node's net.createServer().listen(path) with a `\\.\pipe\...` path creates a
// named pipe; the client dials the same pipe name. The timeout bounds the
// connect (go-winio blocks until the pipe is available otherwise).
func dialNeoSocket(path string, timeout time.Duration) (net.Conn, error) {
	d := timeout
	return winio.DialPipe(path, &d)
}
