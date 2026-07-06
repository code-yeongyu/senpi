package bridge

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// shortSocketPath returns a unix-socket path short enough to satisfy the
// sun_path length limit (~104 bytes on macOS). t.TempDir() paths are too long,
// so we use a short name under os.TempDir() and unlink it on cleanup.
func shortSocketPath(t *testing.T) string {
	t.Helper()
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	p := filepath.Join(os.TempDir(), "neo-"+hex.EncodeToString(b[:])+".sock")
	t.Cleanup(func() { _ = os.Remove(p) })
	return p
}

// fakeDaemon accepts one connection on a unix socket, reads the hello line, and
// replies with the scripted reply line. It mimics the task-15 daemon's handshake
// step (neo-daemon-mode.ts completeHandshake) without a real runtime.
type fakeDaemon struct {
	ln        net.Listener
	socket    string
	lastHello NeoHelloMessage
	helloCh   chan NeoHelloMessage
}

func startFakeDaemon(t *testing.T, replyLine string) *fakeDaemon {
	t.Helper()
	socket := shortSocketPath(t)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	fd := &fakeDaemon{ln: ln, socket: socket, helloCh: make(chan NeoHelloMessage, 1)}
	go func() {
		conn, aerr := ln.Accept()
		if aerr != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		r := bufio.NewReader(conn)
		line, rerr := r.ReadString('\n')
		if rerr != nil {
			return
		}
		var h NeoHelloMessage
		if json.Unmarshal([]byte(line), &h) == nil {
			fd.helloCh <- h
		}
		_, _ = conn.Write([]byte(replyLine + "\n"))
		// Keep the connection open briefly so the client can observe the reply and
		// then use the transport.
		time.Sleep(200 * time.Millisecond)
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return fd
}

func TestDaemonHandshake_WelcomeAttachesTransport(t *testing.T) {
	fd := startFakeDaemon(t, `{"type":"welcome","version":1}`)

	opts := NeoRuntimeOptions{Model: strPtr("m")}
	tr, err := DialAndHandshake(DialConfig{
		Socket:         fd.socket,
		Token:          "tok-abc",
		Version:        NeoDaemonProtocolVersion,
		Capabilities:   []string{"custom_unsupported"},
		RuntimeOptions: opts,
		Timeout:        2 * time.Second,
	})
	if err != nil {
		t.Fatalf("DialAndHandshake welcome: %v", err)
	}
	t.Cleanup(func() { _ = tr.Close() })

	select {
	case h := <-fd.helloCh:
		if h.Type != "hello" || h.Token != "tok-abc" || h.Version != 1 {
			t.Fatalf("hello wire wrong: %+v", h)
		}
		if len(h.Capabilities) != 1 || h.Capabilities[0] != "custom_unsupported" {
			t.Fatalf("capabilities not sent: %+v", h.Capabilities)
		}
		if h.RuntimeOptions == nil || h.RuntimeOptions.Model == nil || *h.RuntimeOptions.Model != "m" {
			t.Fatalf("runtimeOptions not sent: %+v", h.RuntimeOptions)
		}
	case <-time.After(time.Second):
		t.Fatalf("daemon never received hello")
	}

	// The returned value must satisfy Transport (io.ReadWriteCloser).
	var _ Transport = tr
}

func TestDaemonHandshake_RefuseBadTokenReturnsTypedError(t *testing.T) {
	fd := startFakeDaemon(t, `{"type":"refuse","code":"bad_token","reason":"Invalid handshake token"}`)

	_, err := DialAndHandshake(DialConfig{
		Socket:  fd.socket,
		Token:   "wrong",
		Version: NeoDaemonProtocolVersion,
		Timeout: 2 * time.Second,
	})
	if err == nil {
		t.Fatalf("expected refuse error, got nil")
	}
	var refErr *HandshakeRefusedError
	if !asHandshakeRefused(err, &refErr) {
		t.Fatalf("expected *HandshakeRefusedError, got %T: %v", err, err)
	}
	if refErr.Code != "bad_token" {
		t.Fatalf("refuse code: %q", refErr.Code)
	}
}

func TestDaemonHandshake_VersionMismatchTypedError(t *testing.T) {
	fd := startFakeDaemon(t, `{"type":"refuse","code":"version_mismatch","reason":"Protocol version mismatch"}`)

	_, err := DialAndHandshake(DialConfig{
		Socket:  fd.socket,
		Token:   "tok",
		Version: 2,
		Timeout: 2 * time.Second,
	})
	var refErr *HandshakeRefusedError
	if !asHandshakeRefused(err, &refErr) || refErr.Code != "version_mismatch" {
		t.Fatalf("expected version_mismatch refuse, got %T: %v", err, err)
	}
}

func TestDaemonHandshake_DialErrorWhenNoSocket(t *testing.T) {
	_, err := DialAndHandshake(DialConfig{
		Socket:  filepath.Join(t.TempDir(), "nonexistent.sock"),
		Token:   "tok",
		Version: NeoDaemonProtocolVersion,
		Timeout: 500 * time.Millisecond,
	})
	if err == nil {
		t.Fatalf("expected dial error for missing socket")
	}
	// A missing socket must NOT be a refuse (it is a connect failure the caller
	// treats as absence → spawn).
	var refErr *HandshakeRefusedError
	if asHandshakeRefused(err, &refErr) {
		t.Fatalf("dial failure must not be a handshake refusal")
	}
}
