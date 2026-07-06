package bridge

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultRequestTimeout mirrors rpc-client.ts (30s). Long-lived, event-completed
// commands (auth login flows, task 13) pass a longer or zero timeout to Request
// so they are exempt — the timeout is per-call, not global, by design.
const DefaultRequestTimeout = 30 * time.Second

// ErrRequestTimeout is the sentinel wrapped when a request's response does not
// arrive within its deadline.
var ErrRequestTimeout = errors.New("bridge: request timeout")

// ErrClientClosed is returned once the client's read loop has stopped (e.g. the
// transport closed or the child exited).
var ErrClientClosed = errors.New("bridge: client closed")

// EventListener receives every non-response line (events, extension_ui_request,
// extension_error) via the demux. Inspect Message.Kind to route.
type EventListener func(Event)

// MessageListener receives the full demuxed Message for every non-response line,
// giving access to Kind (event / extension_ui_request / extension_error).
type MessageListener func(Message)

// Client correlates requests with responses over a Transport and fans out
// events. It mirrors rpc-client.ts semantics: req_N ids, per-request timeout,
// malformed-line tolerance, and exit-error propagation to pending requests.
type Client struct {
	transport   Transport
	writer      LineWriter
	closeErr    error
	done        chan struct{}
	pending     map[string]chan Message
	eventFns    []EventListener
	messageFns  []MessageListener
	requestID   atomic.Uint64
	listenersMu sync.RWMutex
	mu          sync.Mutex
	closed      bool
}

// LineWriter is the subset of Transport the client uses to write command lines.
// It is separated so tests can supply a channel-backed writer.
type LineWriter interface {
	Write(p []byte) (int, error)
}

// NewClient wraps a Transport and starts the stdout read loop.
func NewClient(t Transport) *Client {
	c := &Client{
		transport: t,
		writer:    t,
		pending:   make(map[string]chan Message),
		done:      make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// OnEvent registers a listener for events (the default demux branch). Returns an
// unsubscribe function.
func (c *Client) OnEvent(fn EventListener) func() {
	c.listenersMu.Lock()
	c.eventFns = append(c.eventFns, fn)
	idx := len(c.eventFns) - 1
	c.listenersMu.Unlock()
	return func() {
		c.listenersMu.Lock()
		if idx < len(c.eventFns) {
			c.eventFns[idx] = nil
		}
		c.listenersMu.Unlock()
	}
}

// OnMessage registers a listener for every non-response line (events,
// extension_ui_request, extension_error) with full Kind access.
func (c *Client) OnMessage(fn MessageListener) func() {
	c.listenersMu.Lock()
	c.messageFns = append(c.messageFns, fn)
	idx := len(c.messageFns) - 1
	c.listenersMu.Unlock()
	return func() {
		c.listenersMu.Lock()
		if idx < len(c.messageFns) {
			c.messageFns[idx] = nil
		}
		c.listenersMu.Unlock()
	}
}

// Request sends a command with a fresh req_N id and waits for the correlated
// response. A timeout of 0 waits indefinitely (task-13 event-completed exemption);
// otherwise the call fails with ErrRequestTimeout after the deadline.
func (c *Client) Request(cmd Command, timeout time.Duration) (Response, error) {
	id := fmt.Sprintf("req_%d", c.requestID.Add(1))

	wire := map[string]any{"type": cmd.Type, "id": id}
	for k, v := range cmd.Fields {
		if k == "type" || k == "id" {
			continue
		}
		wire[k] = v
	}

	ch := make(chan Message, 1)
	c.mu.Lock()
	if c.closed {
		err := c.closeErr
		c.mu.Unlock()
		if err == nil {
			err = ErrClientClosed
		}
		return Response{}, err
	}
	c.pending[id] = ch
	c.mu.Unlock()

	line, err := serializeValue(wire)
	if err != nil {
		c.clearPending(id)
		return Response{}, err
	}
	if _, err := c.writer.Write(line); err != nil {
		c.clearPending(id)
		return Response{}, err
	}

	var timer <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		timer = t.C
	}

	select {
	case msg, ok := <-ch:
		if !ok || msg.raw == nil {
			// Channel closed by failAll: the transport ended before a response.
			c.mu.Lock()
			err := c.closeErr
			c.mu.Unlock()
			if err == nil {
				err = ErrClientClosed
			}
			return Response{}, err
		}
		return msg.AsResponse()
	case <-timer:
		c.clearPending(id)
		return Response{}, fmt.Errorf("%w for %s after %s", ErrRequestTimeout, cmd.Type, timeout)
	case <-c.done:
		c.mu.Lock()
		err := c.closeErr
		c.mu.Unlock()
		if err == nil {
			err = ErrClientClosed
		}
		return Response{}, err
	}
}

func (c *Client) clearPending(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// readLoop consumes stdout lines, correlates responses, and fans out events. A
// malformed (non-JSON) line is dropped, matching rpc-client.ts.
func (c *Client) readLoop() {
	defer close(c.done)
	r := NewLineReader(c.transport)
	for {
		line, err := r.ReadLine()
		if err != nil {
			c.failAll(c.readExitError(err))
			return
		}
		msg, derr := DecodeMessage(line)
		if derr != nil {
			continue // malformed / blank line — ignore (rpc-client parity)
		}
		if msg.Kind == DemuxResponse && msg.ID != "" {
			c.mu.Lock()
			ch, ok := c.pending[msg.ID]
			if ok {
				delete(c.pending, msg.ID)
			}
			c.mu.Unlock()
			if ok {
				ch <- msg
				continue
			}
			// A response with no waiter falls through to listeners for observability.
		}
		c.dispatch(msg)
	}
}

// readExitError prefers the transport's typed exit error (with stderr) over the
// bare read error.
func (c *Client) readExitError(readErr error) error {
	if st, ok := c.transport.(*StdioTransport); ok {
		<-st.Done()
		if xe := st.ExitError(); xe != nil {
			return xe
		}
	}
	return readErr
}

func (c *Client) dispatch(msg Message) {
	ev := Event{Type: msg.Type, Payload: append([]byte(nil), msg.raw...)}
	c.listenersMu.RLock()
	efns := append([]EventListener(nil), c.eventFns...)
	mfns := append([]MessageListener(nil), c.messageFns...)
	c.listenersMu.RUnlock()
	for _, fn := range efns {
		if fn != nil {
			fn(ev)
		}
	}
	for _, fn := range mfns {
		if fn != nil {
			fn(msg)
		}
	}
}

// failAll rejects every pending request and marks the client closed. Called when
// the read loop ends (transport closed or child exited) — rpc-client.ts
// rejectPendingRequests parity.
func (c *Client) failAll(err error) {
	c.mu.Lock()
	c.closed = true
	c.closeErr = err
	pending := c.pending
	c.pending = make(map[string]chan Message)
	c.mu.Unlock()
	for _, ch := range pending {
		close(ch) // waiter observes closed channel; Request treats it as done
	}
}

// Done returns a channel closed when the client's read loop has stopped (the
// transport ended or the child/daemon connection dropped). The recovery loop
// waits on it to detect a disconnect and trigger reconnect/respawn.
func (c *Client) Done() <-chan struct{} { return c.done }

// Close stops the client and closes the underlying transport.
func (c *Client) Close() error {
	return c.transport.Close()
}
