package bridge

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"time"
)

// NeoHelloMessage is the first line a client sends on a fresh daemon connection.
// It mirrors NeoHelloMessage in neo-daemon-protocol.ts.
type NeoHelloMessage struct {
	Type           string             `json:"type"`
	Token          string             `json:"token"`
	Version        int                `json:"version"`
	Capabilities   []string           `json:"capabilities,omitempty"`
	RuntimeOptions *NeoRuntimeOptions `json:"runtimeOptions,omitempty"`
}

// neoHandshakeReply is the daemon's single reply line: welcome or refuse.
type neoHandshakeReply struct {
	Type         string   `json:"type"`
	Version      int      `json:"version"`
	Capabilities []string `json:"capabilities,omitempty"`
	Reason       string   `json:"reason,omitempty"`
	Code         string   `json:"code,omitempty"`
}

// HandshakeRefusedError carries a daemon `refuse` reply. The caller inspects
// Code to decide: version_mismatch/unsupported_options → fall back to isolated;
// bad_token → the record is stale/wrong (respawn); malformed_hello → a protocol
// bug. It is distinct from a dial/connect failure (which signals daemon absence).
type HandshakeRefusedError struct {
	Code   string
	Reason string
}

func (e *HandshakeRefusedError) Error() string {
	return fmt.Sprintf("neo handshake refused (%s): %s", e.Code, e.Reason)
}

// asHandshakeRefused is a small errors.As helper used by tests and the client.
func asHandshakeRefused(err error, target **HandshakeRefusedError) bool {
	return errors.As(err, target)
}

// DialConfig configures a single dial+handshake attempt against a daemon socket.
type DialConfig struct {
	// Socket is the unix socket path (POSIX) or named-pipe path (Windows).
	Socket string
	// Token is the registry token presented in the hello.
	Token string
	// Version is the protocol version; must equal the daemon's.
	Version int
	// Capabilities are the client capability opt-ins (e.g. custom_unsupported).
	Capabilities []string
	// RuntimeOptions is the per-connection runtime payload built from the --neo
	// passthrough argv (ParseNeoRuntimeArgv).
	RuntimeOptions NeoRuntimeOptions
	// Timeout bounds the whole dial+handshake. Zero means a 5s default.
	Timeout time.Duration
}

const defaultHandshakeTimeout = 5 * time.Second

// DialAndHandshake dials the daemon socket, sends the hello line, reads the
// single welcome/refuse reply, and on welcome returns a Transport carrying the
// ordinary JSONL RPC protocol for this connection's runtime. On refuse it returns
// a *HandshakeRefusedError; on a dial/read failure it returns the underlying
// error (which the caller treats as daemon absence).
func DialAndHandshake(cfg DialConfig) (Transport, error) {
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultHandshakeTimeout
	}
	deadline := time.Now().Add(timeout)

	conn, err := dialNeoSocket(cfg.Socket, timeout)
	if err != nil {
		return nil, fmt.Errorf("bridge: dial daemon socket %s: %w", cfg.Socket, err)
	}

	// Bound the handshake I/O by the remaining deadline.
	_ = conn.SetDeadline(deadline)

	hello := NeoHelloMessage{
		Type:         "hello",
		Token:        cfg.Token,
		Version:      cfg.Version,
		Capabilities: cfg.Capabilities,
	}
	// Only attach runtimeOptions when non-empty so the daemon applies classic
	// defaults for an all-default connection (omitempty at the field level already
	// keeps the payload minimal; a pointer keeps the whole key absent when zero).
	if !runtimeOptionsEmpty(cfg.RuntimeOptions) {
		opts := cfg.RuntimeOptions
		hello.RuntimeOptions = &opts
	}

	helloLine, err := json.Marshal(hello)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("bridge: marshal hello: %w", err)
	}
	if _, err := conn.Write(append(helloLine, '\n')); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("bridge: write hello: %w", err)
	}

	reader := bufio.NewReader(conn)
	replyLine, err := reader.ReadString('\n')
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("bridge: read handshake reply: %w", err)
	}

	var reply neoHandshakeReply
	if err := json.Unmarshal([]byte(replyLine), &reply); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("bridge: decode handshake reply: %w", err)
	}

	switch reply.Type {
	case "welcome":
		// Clear the handshake deadline; the RPC stream is long-lived.
		_ = conn.SetDeadline(time.Time{})
		return newSocketTransport(conn, reader), nil
	case "refuse":
		_ = conn.Close()
		return nil, &HandshakeRefusedError{Code: reply.Code, Reason: reply.Reason}
	default:
		_ = conn.Close()
		return nil, fmt.Errorf("bridge: unexpected handshake reply type %q", reply.Type)
	}
}

// runtimeOptionsEmpty reports whether the options carry no set field, so the
// hello omits the runtimeOptions key entirely (classic defaults).
func runtimeOptionsEmpty(o NeoRuntimeOptions) bool {
	b, err := json.Marshal(o)
	if err != nil {
		return false
	}
	return string(b) == "{}"
}

// socketTransport adapts a net.Conn (unix socket or named pipe) to the Transport
// interface. Reads go through the bufio.Reader used for the handshake so any
// bytes it buffered past the reply line are not lost.
type socketTransport struct {
	conn   net.Conn
	reader *bufio.Reader
}

func newSocketTransport(conn net.Conn, reader *bufio.Reader) *socketTransport {
	return &socketTransport{conn: conn, reader: reader}
}

func (t *socketTransport) Read(p []byte) (int, error)  { return t.reader.Read(p) }
func (t *socketTransport) Write(p []byte) (int, error) { return t.conn.Write(p) }
func (t *socketTransport) Close() error                { return t.conn.Close() }
