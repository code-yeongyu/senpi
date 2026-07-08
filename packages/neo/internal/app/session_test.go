package app_test

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeTransport is an in-memory bridge.Transport (io.ReadWriteCloser). Read
// yields queued stdout lines (LF-framed) and Write forwards command lines to
// fromCli for a fake-server goroutine. It mirrors the bridge package's own fake
// (internal/bridge/transport_test.go) so the adapter drives a real bridge.Client.
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
			return 0, errEOF
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
		return 0, errClosedPipe
	}
	return len(p), nil
}

func (f *fakeTransport) Close() error {
	f.closeOne.Do(func() { close(f.closed) })
	return nil
}

var (
	errEOF        = errors.New("EOF")
	errClosedPipe = errors.New("closed pipe")
)

// fakeSender captures every tea.Msg the adapter pushes, in order.
type fakeSender struct {
	msgs chan tea.Msg
}

func newFakeSender() *fakeSender { return &fakeSender{msgs: make(chan tea.Msg, 256)} }

func (s *fakeSender) Send(msg tea.Msg) { s.msgs <- msg }

// recorder is a fake RPC server: it records every command line the client writes
// and replies with a correlated success response so Client.Request completes.
type recorder struct {
	mu   sync.Mutex
	cmds []map[string]any
}

func (r *recorder) serve(ft *fakeTransport) {
	go func() {
		for raw := range ft.fromCli {
			var cmd map[string]any
			if err := json.Unmarshal(raw, &cmd); err != nil {
				continue
			}
			r.mu.Lock()
			r.cmds = append(r.cmds, cmd)
			r.mu.Unlock()
			id, _ := cmd["id"].(string)
			typ, _ := cmd["type"].(string)
			resp, _ := json.Marshal(map[string]any{
				"id": id, "type": "response", "command": typ, "success": true,
			})
			select {
			case ft.toClient <- resp:
			case <-ft.closed:
				return
			}
		}
	}()
}

func (r *recorder) commands() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]map[string]any, len(r.cmds))
	copy(out, r.cmds)
	return out
}

// recvMsg reads the next captured message or fails on timeout.
func recvMsg(t *testing.T, s *fakeSender, timeout time.Duration) tea.Msg {
	t.Helper()
	select {
	case m := <-s.msgs:
		return m
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for adapter message")
		return nil
	}
}

// execCmd runs a tea.Cmd to completion, flattening tea.Batch results (which may
// collapse to a single cmd or a BatchMsg of cmds) into the messages produced.
func execCmd(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	msg := cmd()
	batch, ok := msg.(tea.BatchMsg)
	if !ok {
		return []tea.Msg{msg}
	}
	var (
		mu  sync.Mutex
		out []tea.Msg
		wg  sync.WaitGroup
	)
	for _, sub := range batch {
		wg.Add(1)
		go func(c tea.Cmd) {
			defer wg.Done()
			sub := execCmd(c)
			mu.Lock()
			out = append(out, sub...)
			mu.Unlock()
		}(sub)
	}
	wg.Wait()
	return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestSessionEventFanInOrdering asserts every non-response line is delivered to
// the program as an EventMsg, in the order the stream produced them.
func TestSessionEventFanInOrdering(t *testing.T) {
	ft := newFakeTransport()
	defer ft.Close()
	client := bridge.NewClient(ft)
	sender := newFakeSender()
	app.NewSession(client, sender, bridge.NeoRuntimeOptions{})

	for _, line := range []string{
		`{"type":"agent_start"}`,
		`{"type":"message_update","content":"h"}`,
		`{"type":"agent_end"}`,
	} {
		ft.toClient <- []byte(line)
	}

	want := []string{"agent_start", "message_update", "agent_end"}
	for i, w := range want {
		msg := recvMsg(t, sender, 2*time.Second)
		ev, ok := msg.(app.EventMsg)
		if !ok {
			t.Fatalf("msg %d: want EventMsg, got %T", i, msg)
		}
		if ev.Event.Type != w {
			t.Fatalf("msg %d: want event %q, got %q", i, w, ev.Event.Type)
		}
	}
}

// TestSessionRequestResponseCorrelation asserts a command helper issues the RPC
// command and resolves its correlated response into a CommandResultMsg.
func TestSessionRequestResponseCorrelation(t *testing.T) {
	ft := newFakeTransport()
	defer ft.Close()
	client := bridge.NewClient(ft)
	sender := newFakeSender()
	sess := app.NewSession(client, sender, bridge.NeoRuntimeOptions{})

	rec := &recorder{}
	rec.serve(ft)

	msgs := execCmd(sess.Prompt("hi"))
	if len(msgs) != 1 {
		t.Fatalf("want 1 message, got %d: %#v", len(msgs), msgs)
	}
	res, ok := msgs[0].(app.CommandResultMsg)
	if !ok {
		t.Fatalf("want CommandResultMsg, got %T", msgs[0])
	}
	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if res.Command != "prompt" || !res.Response.Success {
		t.Fatalf("unexpected result: %+v", res)
	}
	cmds := rec.commands()
	if len(cmds) != 1 || cmds[0]["type"] != "prompt" || cmds[0]["message"] != "hi" {
		t.Fatalf("unexpected wire commands: %#v", cmds)
	}
}

// TestSessionInitialPromptEmission asserts positional launch text is delivered as
// a single joined `prompt` command.
func TestSessionInitialPromptEmission(t *testing.T) {
	ft := newFakeTransport()
	defer ft.Close()
	client := bridge.NewClient(ft)
	sender := newFakeSender()
	sess := app.NewSession(client, sender, bridge.NeoRuntimeOptions{
		Messages: []string{"hello", "world"},
	})

	rec := &recorder{}
	rec.serve(ft)

	msgs := execCmd(sess.InitialInputs())
	if len(msgs) != 1 {
		t.Fatalf("want 1 message, got %d: %#v", len(msgs), msgs)
	}
	if _, ok := msgs[0].(app.CommandResultMsg); !ok {
		t.Fatalf("want CommandResultMsg, got %T", msgs[0])
	}
	cmds := rec.commands()
	if len(cmds) != 1 {
		t.Fatalf("want exactly one prompt command, got %#v", cmds)
	}
	if cmds[0]["type"] != "prompt" || cmds[0]["message"] != "hello world" {
		t.Fatalf("initial prompt not joined text: %#v", cmds[0])
	}
}

// TestSessionInitialFileArgNotice asserts that when launch @file args are present
// the adapter surfaces the exact one-line notice and never sends the @file as an
// unexpanded prompt (only the plain positional text is delivered).
func TestSessionInitialFileArgNotice(t *testing.T) {
	const wantNotice = "initial @file at launch is not supported under --neo; add it after startup"

	ft := newFakeTransport()
	defer ft.Close()
	client := bridge.NewClient(ft)
	sender := newFakeSender()
	sess := app.NewSession(client, sender, bridge.NeoRuntimeOptions{
		Messages: []string{"hello"},
		FileArgs: []string{"notes.md"},
	})

	rec := &recorder{}
	rec.serve(ft)

	msgs := execCmd(sess.InitialInputs())

	var noticeText string
	var sawNotice bool
	for _, m := range msgs {
		if n, ok := m.(app.NoticeMsg); ok {
			noticeText = n.Text
			sawNotice = true
		}
	}
	if !sawNotice {
		t.Fatalf("no NoticeMsg emitted; got %#v", msgs)
	}
	if noticeText != wantNotice {
		t.Fatalf("notice mismatch:\n got:  %q\n want: %q", noticeText, wantNotice)
	}

	for _, cmd := range rec.commands() {
		if cmd["type"] != "prompt" {
			continue
		}
		message, _ := cmd["message"].(string)
		if strings.Contains(message, "@") {
			t.Fatalf("@-literal prompt was sent: %q", message)
		}
		if message != "hello" {
			t.Fatalf("prompt should carry only plain text, got %q", message)
		}
	}
}

// TestSessionClientClosedPropagation asserts the read loop ending surfaces a
// typed ClientClosedMsg wrapping ErrClientClosed.
func TestSessionClientClosedPropagation(t *testing.T) {
	ft := newFakeTransport()
	client := bridge.NewClient(ft)
	sender := newFakeSender()
	app.NewSession(client, sender, bridge.NeoRuntimeOptions{})

	ft.Close() // ends the read loop → client closed

	deadline := time.After(2 * time.Second)
	for {
		select {
		case msg := <-sender.msgs:
			closed, ok := msg.(app.ClientClosedMsg)
			if !ok {
				continue
			}
			if !errors.Is(closed.Err, bridge.ErrClientClosed) {
				t.Fatalf("ClientClosedMsg err not ErrClientClosed: %v", closed.Err)
			}
			return
		case <-deadline:
			t.Fatalf("no ClientClosedMsg after transport close")
		}
	}
}

// TestSessionExtensionUIRequestDelivery asserts extension_ui_request lines reach
// the program as typed ExtensionUIRequestMsg values with per-method fields.
func TestSessionExtensionUIRequestDelivery(t *testing.T) {
	ft := newFakeTransport()
	defer ft.Close()
	client := bridge.NewClient(ft)
	sender := newFakeSender()
	app.NewSession(client, sender, bridge.NeoRuntimeOptions{})

	ft.toClient <- []byte(`{"type":"extension_ui_request","id":"u1","method":"confirm","message":"ok?"}`)

	msg := recvMsg(t, sender, 2*time.Second)
	req, ok := msg.(app.ExtensionUIRequestMsg)
	if !ok {
		t.Fatalf("want ExtensionUIRequestMsg, got %T", msg)
	}
	if req.Request.Method != "confirm" || req.Request.ID != "u1" {
		t.Fatalf("unexpected request: %+v", req.Request)
	}
	if req.Request.Fields["message"] != "ok?" {
		t.Fatalf("per-method field missing: %#v", req.Request.Fields)
	}
}

// TestSessionExtensionErrorDelivery asserts extension_error lines reach the
// program as typed ExtensionErrorMsg values carrying the raw line.
func TestSessionExtensionErrorDelivery(t *testing.T) {
	ft := newFakeTransport()
	defer ft.Close()
	client := bridge.NewClient(ft)
	sender := newFakeSender()
	app.NewSession(client, sender, bridge.NeoRuntimeOptions{})

	ft.toClient <- []byte(`{"type":"extension_error","extensionPath":"/x","event":"foo","error":"boom"}`)

	msg := recvMsg(t, sender, 2*time.Second)
	extErr, ok := msg.(app.ExtensionErrorMsg)
	if !ok {
		t.Fatalf("want ExtensionErrorMsg, got %T", msg)
	}
	if extErr.Message.Type != "extension_error" {
		t.Fatalf("unexpected message type: %q", extErr.Message.Type)
	}
	if !strings.Contains(string(extErr.Message.Raw()), "boom") {
		t.Fatalf("raw payload missing error: %s", extErr.Message.Raw())
	}
}

// TestSessionBootstrapFanIn asserts Bootstrap fans get_state + get_commands +
// get_available_models out concurrently and returns one combined BootstrapMsg.
func TestSessionBootstrapFanIn(t *testing.T) {
	ft := newFakeTransport()
	defer ft.Close()
	client := bridge.NewClient(ft)
	sender := newFakeSender()
	sess := app.NewSession(client, sender, bridge.NeoRuntimeOptions{})

	rec := &recorder{}
	rec.serve(ft)

	msgs := execCmd(sess.Bootstrap())
	if len(msgs) != 1 {
		t.Fatalf("want 1 message, got %d: %#v", len(msgs), msgs)
	}
	boot, ok := msgs[0].(app.BootstrapMsg)
	if !ok {
		t.Fatalf("want BootstrapMsg, got %T", msgs[0])
	}
	if boot.Err != nil {
		t.Fatalf("unexpected bootstrap error: %v", boot.Err)
	}
	if !boot.State.Success || !boot.Commands.Success || !boot.Models.Success {
		t.Fatalf("bootstrap responses not all successful: %+v", boot)
	}
	seen := map[string]bool{}
	for _, cmd := range rec.commands() {
		if typ, ok := cmd["type"].(string); ok {
			seen[typ] = true
		}
	}
	for _, want := range []string{"get_state", "get_commands", "get_available_models"} {
		if !seen[want] {
			t.Fatalf("bootstrap did not issue %q; issued %#v", want, seen)
		}
	}
}
