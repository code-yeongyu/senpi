package bridge

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// extractID pulls the "id" discriminant from a raw command line so the fake
// server can echo a correlated response.
func extractID(raw []byte) string {
	var d struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		return ""
	}
	return d.ID
}

// fakeTransport is an in-memory Transport used to unit-test the Client's
// correlation, timeout, and demux wiring without spawning a real process. It
// implements io.ReadWriteCloser: Read yields queued stdout lines (LF-framed) and
// Write forwards command lines to fromCli for the fake server goroutine.
type fakeTransport struct {
	toClient chan []byte
	fromCli  chan []byte
	closed   chan struct{}
	readBuf  []byte
	closeOne sync.Once
}

func newFakeTransport() *fakeTransport {
	return &fakeTransport{
		toClient: make(chan []byte, 64),
		fromCli:  make(chan []byte, 64),
		closed:   make(chan struct{}),
	}
}

func (f *fakeTransport) Read(p []byte) (int, error) {
	if len(f.readBuf) == 0 {
		select {
		case line := <-f.toClient:
			f.readBuf = append(line, '\n')
		case <-f.closed:
			return 0, io.EOF
		}
	}
	n := copy(p, f.readBuf)
	f.readBuf = f.readBuf[n:]
	return n, nil
}

func (f *fakeTransport) Write(p []byte) (int, error) {
	cp := make([]byte, len(p))
	copy(cp, p)
	select {
	case f.fromCli <- cp:
	case <-f.closed:
		return 0, io.ErrClosedPipe
	}
	return len(p), nil
}

func (f *fakeTransport) Close() error {
	f.closeOne.Do(func() { close(f.closed) })
	return nil
}

// TestClientRequestIDCorrelation asserts the Client assigns req_N ids and
// resolves a request with the response carrying the matching id (rpc-client.ts
// parity: `req_${++requestId}`).
func TestClientRequestIDCorrelation(t *testing.T) {
	ft := newFakeTransport()
	client := NewClient(ft)

	// Echo server: whatever id the client sends, reply with a matching response.
	go func() {
		for raw := range ft.fromCli {
			id := extractID(raw)
			if id == "" {
				continue
			}
			ft.toClient <- []byte(`{"id":"` + id + `","type":"response","command":"get_state","success":true,"data":{"thinkingLevel":"off","isStreaming":false,"isCompacting":false,"steeringMode":"all","followUpMode":"all","sessionId":"s","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}`)
		}
	}()

	resp, err := client.Request(Command{Type: "get_state"}, 5*time.Second)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.Command != "get_state" || !resp.Success {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

// TestClientRequestTimeout asserts a request whose response never arrives fails
// with a timeout error (30s default, overridable — task-13 exemption hook).
func TestClientRequestTimeout(t *testing.T) {
	ft := newFakeTransport()
	client := NewClient(ft)
	_, err := client.Request(Command{Type: "get_state"}, 50*time.Millisecond)
	if err == nil {
		t.Fatalf("expected timeout error")
	}
	if !errors.Is(err, ErrRequestTimeout) {
		t.Fatalf("expected ErrRequestTimeout, got %v", err)
	}
}

// TestClientMalformedLineIgnored asserts a non-JSON stdout line is ignored, not
// fatal (rpc-client.ts parity: try/catch around JSON.parse swallows it).
func TestClientMalformedLineIgnored(t *testing.T) {
	ft := newFakeTransport()
	client := NewClient(ft)

	go func() {
		for raw := range ft.fromCli {
			id := extractID(raw)
			ft.toClient <- []byte("this is not json at all") // must be ignored
			ft.toClient <- []byte("")                        // blank ignored
			ft.toClient <- []byte(`{"id":"` + id + `","type":"response","command":"abort","success":true}`)
		}
	}()

	resp, err := client.Request(Command{Type: "abort"}, 5*time.Second)
	if err != nil {
		t.Fatalf("malformed line should be ignored, got err: %v", err)
	}
	if resp.Command != "abort" {
		t.Fatalf("unexpected: %+v", resp)
	}
}

// TestClientEventDelivery asserts non-response lines are delivered to event
// subscribers via the demux path.
func TestClientEventDelivery(t *testing.T) {
	ft := newFakeTransport()
	client := NewClient(ft)

	got := make(chan Event, 1)
	client.OnEvent(func(e Event) { got <- e })

	ft.toClient <- []byte(`{"type":"agent_start"}`)

	select {
	case e := <-got:
		if e.Type != "agent_start" {
			t.Fatalf("event type=%q", e.Type)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("event not delivered")
	}
}

// TestStdioTransportSpawnArgs asserts the StdioTransport builds the correct
// `node <cli> --mode rpc` argv (rpc-client.ts parity).
func TestStdioTransportSpawnArgs(t *testing.T) {
	args := stdioSpawnArgs("/path/to/cli.js", []string{"--provider", "mock"})
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--mode rpc") {
		t.Fatalf("argv missing --mode rpc: %v", args)
	}
	if args[0] != "/path/to/cli.js" {
		t.Fatalf("cli path should lead argv: %v", args)
	}
}
