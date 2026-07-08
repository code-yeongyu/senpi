package app

import (
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript"
)

func testTheme(t *testing.T) *theme.Theme {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	return th
}

// runCmd executes a tea.Cmd, flattening a single BatchMsg level, and returns the
// produced messages.
func runCmd(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	switch m := cmd().(type) {
	case tea.BatchMsg:
		var out []tea.Msg
		for _, sub := range m {
			out = append(out, runCmd(sub)...)
		}
		return out
	case nil:
		return nil
	default:
		return []tea.Msg{m}
	}
}

// TestNoticeMsgRendersInFeed asserts the NoticeMsg route lands a visible entry in
// the transcript (the seam the launch @file notice + router degrade paths use).
func TestNoticeMsgRendersInFeed(t *testing.T) {
	th := testTheme(t)
	feed := transcript.NewFeed(transcript.NewRenderTheme(th))
	m := &Model{theme: th, feed: feed}

	m.Update(NoticeMsg{Text: "launch-notice-xyz"})

	joined := strings.Join(feed.Render(80), "\n")
	if !strings.Contains(joined, "launch-notice-xyz") {
		t.Fatalf("NoticeMsg not rendered in the feed; got:\n%s", joined)
	}
}

// TestEventRoutesStreamingState asserts agent_start/agent_end flip the router's
// streaming flag (proving EventMsg fans onto the input router).
func TestEventRoutesStreamingState(t *testing.T) {
	th := testTheme(t)
	keys := keybindings.NewManager(nil)
	feed := transcript.NewFeed(transcript.NewRenderTheme(th))
	sh := shell.New(th, "", "senpi")
	router := NewRouter(slash.NewDispatcher(slash.NewBuiltins()), sh.Queue(), &recordingCommander{}, th)
	m := &Model{
		theme: th, keys: keys, feed: feed,
		xscript:  NewTranscript(feed, keys),
		router:   router,
		recovery: NewRecovery(RecoveryConfig{Mode: bridge.TransportIsolated}),
	}

	m.Update(EventMsg{Event: bridge.Event{Type: "agent_start"}})
	if !router.Streaming() {
		t.Fatalf("agent_start did not set router streaming")
	}
	m.Update(EventMsg{Event: bridge.Event{Type: "agent_end"}})
	if router.Streaming() {
		t.Fatalf("agent_end did not clear router streaming")
	}
}

// TestBashResultConsumedByRouter asserts a bash CommandResultMsg is folded into
// the router's live block (the CommandResultMsg → Router.HandleBashResult seam).
func TestBashResultConsumedByRouter(t *testing.T) {
	th := testTheme(t)
	sh := shell.New(th, "", "senpi")
	router := NewRouter(slash.NewDispatcher(slash.NewBuiltins()), sh.Queue(), &recordingCommander{}, th)
	m := &Model{theme: th, feed: transcript.NewFeed(transcript.NewRenderTheme(th)), router: router}

	if res := router.Submit("!echo hi"); res.Kind != RouteBash {
		t.Fatalf("expected RouteBash, got %v", res.Kind)
	}
	if !router.IsBashRunning() {
		t.Fatalf("bash should be running after submit")
	}

	m.Update(CommandResultMsg{
		Command:  "bash",
		Response: bridge.Response{Success: true, Data: json.RawMessage(`{"output":"hi\n","exitCode":0}`)},
	})
	if router.IsBashRunning() {
		t.Fatalf("bash result was not consumed by the router")
	}
}

// TestRecoveryFatalRecordsExitAndQuits asserts a fatal recovery signal records the
// exit code and returns the quit command.
func TestRecoveryFatalRecordsExitAndQuits(t *testing.T) {
	th := testTheme(t)
	m := &Model{theme: th, feed: transcript.NewFeed(transcript.NewRenderTheme(th))}

	_, cmd := m.Update(RecoveryFatalMsg{Notice: "backend gone", ExitCode: 1})
	if m.ExitCode() != 1 {
		t.Fatalf("exit code not recorded: got %d", m.ExitCode())
	}
	if cmd == nil {
		t.Fatalf("fatal did not return a command")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatalf("fatal command was not tea.Quit")
	}
}

// TestBootstrapDeliversInitialInputsOnce asserts the launch prompt is sent after
// the FIRST bootstrap only — a recovery re-bootstrap must not re-send it.
func TestBootstrapDeliversInitialInputsOnce(t *testing.T) {
	th := testTheme(t)
	keys := keybindings.NewManager(nil)
	feed := transcript.NewFeed(transcript.NewRenderTheme(th))
	sh := shell.New(th, "", "senpi")

	srv := newEchoClient(t)
	defer srv.close()
	ref := &clientRef{}
	opts := bridge.NeoRuntimeOptions{Messages: []string{"launch-prompt"}}
	ref.set(srv.client, NewSession(srv.client, discardSender{}, opts))

	router := NewRouter(slash.NewDispatcher(slash.NewBuiltins()), sh.Queue(), refCommander{ref: ref}, th)
	wire := NewShellWire(sh, ShellWireConfig{Theme: th, Keys: keys, AppName: "senpi"})
	m := &Model{
		theme: th, keys: keys, feed: feed,
		ref: ref, xscript: NewTranscript(feed, keys), wire: wire, router: router,
		requester: &overlayRequester{ref: ref},
	}

	boot := BootstrapMsg{
		State:    bridge.Response{Success: true, Command: "get_state", Data: json.RawMessage(`{"thinkingLevel":"off"}`)},
		Commands: bridge.Response{Success: true, Command: "get_commands", Data: json.RawMessage(`{"commands":[]}`)},
		Models:   bridge.Response{Success: true, Command: "get_available_models", Data: json.RawMessage(`{"models":[]}`)},
	}

	_, cmd := m.Update(boot)
	if !m.initialInputsSent {
		t.Fatalf("first bootstrap did not latch initialInputsSent")
	}
	runCmd(cmd) // fires the launch prompt through the echo client
	if got := srv.commandsSeen(); !contains(got, "prompt") {
		t.Fatalf("first bootstrap did not deliver the launch prompt; commands=%v", got)
	}

	srv.reset()
	_, cmd2 := m.Update(boot)
	runCmd(cmd2)
	if got := srv.commandsSeen(); contains(got, "prompt") {
		t.Fatalf("re-bootstrap wrongly re-sent the launch prompt; commands=%v", got)
	}
}

// TestAbortRequestedIssuesAbort asserts app.interrupt (with no bash running) aborts
// the in-flight agent turn via the session.
func TestAbortRequestedIssuesAbort(t *testing.T) {
	th := testTheme(t)
	srv := newEchoClient(t)
	defer srv.close()
	ref := &clientRef{}
	ref.set(srv.client, NewSession(srv.client, discardSender{}, bridge.NeoRuntimeOptions{}))
	m := &Model{theme: th, feed: transcript.NewFeed(transcript.NewRenderTheme(th)), ref: ref}

	_, cmd := m.Update(AbortRequested{})
	runCmd(cmd)
	if got := srv.commandsSeen(); !contains(got, "abort") {
		t.Fatalf("AbortRequested did not issue an abort command; commands=%v", got)
	}
}

// --- test doubles -------------------------------------------------------------

// recordingCommander satisfies Commander; its commands are inert (nil cmds) so the
// router's state transitions can be asserted without a live transport.
type recordingCommander struct{}

func (recordingCommander) Prompt(string) tea.Cmd          { return nil }
func (recordingCommander) Steer(string) tea.Cmd           { return nil }
func (recordingCommander) FollowUp(string) tea.Cmd        { return nil }
func (recordingCommander) AbortBash() tea.Cmd             { return nil }
func (recordingCommander) Request(bridge.Command) tea.Cmd { return nil }
func (recordingCommander) Bash(string, bool) tea.Cmd      { return nil }

// discardSender drops program messages (the routing under test doesn't inspect
// pumped events).
type discardSender struct{}

func (discardSender) Send(tea.Msg) {}

// echoClient wraps a bridge.Client over an in-memory transport whose fake server
// answers every command with a success response and records the command types.
type echoClient struct {
	client *bridge.Client
	tr     *pipeTransport
	mu     sync.Mutex
	seen   []string
}

func newEchoClient(t *testing.T) *echoClient {
	t.Helper()
	tr := newPipeTransport()
	ec := &echoClient{tr: tr}
	ec.client = bridge.NewClient(tr)
	go ec.serve()
	return ec
}

func (e *echoClient) serve() {
	for raw := range e.tr.written {
		var d struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if json.Unmarshal(raw, &d) != nil || d.ID == "" {
			continue
		}
		e.mu.Lock()
		e.seen = append(e.seen, d.Type)
		e.mu.Unlock()
		e.tr.deliver([]byte(`{"id":"` + d.ID + `","type":"response","command":"` + d.Type + `","success":true}`))
	}
}

func (e *echoClient) commandsSeen() []string {
	// Allow the async serve goroutine to record before the assertion reads.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		e.mu.Lock()
		n := len(e.seen)
		e.mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	out := append([]string(nil), e.seen...)
	return out
}

func (e *echoClient) reset() {
	e.mu.Lock()
	e.seen = nil
	e.mu.Unlock()
}

func (e *echoClient) close() { _ = e.client.Close() }

// pipeTransport is an in-memory bridge.Transport: Write forwards LF-framed command
// lines to `written`; deliver queues response/event lines for Read.
type pipeTransport struct {
	written  chan []byte
	toClient chan []byte
	closed   chan struct{}
	readBuf  []byte
	once     sync.Once
}

func newPipeTransport() *pipeTransport {
	return &pipeTransport{
		written:  make(chan []byte, 64),
		toClient: make(chan []byte, 64),
		closed:   make(chan struct{}),
	}
}

func (p *pipeTransport) Read(b []byte) (int, error) {
	if len(p.readBuf) == 0 {
		select {
		case line := <-p.toClient:
			p.readBuf = append(line, '\n')
		case <-p.closed:
			return 0, io.EOF
		}
	}
	n := copy(b, p.readBuf)
	p.readBuf = p.readBuf[n:]
	return n, nil
}

func (p *pipeTransport) Write(b []byte) (int, error) {
	cp := make([]byte, len(b))
	copy(cp, b)
	select {
	case p.written <- cp:
	case <-p.closed:
		return 0, io.ErrClosedPipe
	}
	return len(b), nil
}

func (p *pipeTransport) deliver(line []byte) {
	select {
	case p.toClient <- line:
	case <-p.closed:
	}
}

func (p *pipeTransport) Close() error {
	p.once.Do(func() { close(p.closed) })
	return nil
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

// sentinelAbortMsg marks that the commander's AbortBash cmd actually executed.
type sentinelAbortMsg struct{}

// abortSentinelCommander is a recordingCommander whose AbortBash returns a live
// cmd, so a routing layer that drops RouteResult.Cmd is caught.
type abortSentinelCommander struct{ recordingCommander }

func (abortSentinelCommander) AbortBash() tea.Cmd {
	return func() tea.Msg { return sentinelAbortMsg{} }
}

// TestInterruptDuringBashIssuesAbortBash asserts the interrupt chord pressed
// while a `!` command runs actually EXECUTES the abort_bash command (regression:
// interpretRoute's default arm returned only the notice and dropped the Cmd, so
// escape never aborted a running bash).
func TestInterruptDuringBashIssuesAbortBash(t *testing.T) {
	th := testTheme(t)
	keys := keybindings.NewManager(nil)
	sh := shell.New(th, "", "senpi")
	router := NewRouter(slash.NewDispatcher(slash.NewBuiltins()), sh.Queue(), abortSentinelCommander{}, th)
	m := &Model{
		theme: th, keys: keys,
		feed:   transcript.NewFeed(transcript.NewRenderTheme(th)),
		router: router,
	}

	if res := router.Submit("!sleep 99"); res.Kind != RouteBash {
		t.Fatalf("expected RouteBash, got %v", res.Kind)
	}
	_, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})

	for _, msg := range runCmd(cmd) {
		if _, ok := msg.(sentinelAbortMsg); ok {
			return // abort_bash executed
		}
	}
	t.Fatalf("escape during running bash did not execute the AbortBash command")
}

// TestModelSwitchRefreshesOverlayContext proves a successful set_model /
// cycle_model round-trip re-points the overlay build context, so reopening the
// /model selector marks the NEW model current (live QA regression: after
// switching to mock-b the reopened selector still ✓-marked mock-a — the backend
// had switched; only this client-side snapshot was stale). thinking_level_changed
// must likewise refresh the thinking snapshot.
func TestModelSwitchRefreshesOverlayContext(t *testing.T) {
	th := testTheme(t)
	m := &Model{theme: th, feed: transcript.NewFeed(transcript.NewRenderTheme(th))}
	m.overlayCtx.currentModel = "mock/mock-a"
	m.overlayCtx.thinkingLevel = "off"

	m.Update(CommandResultMsg{
		Command:  "set_model",
		Response: bridge.Response{Success: true, Data: json.RawMessage(`{"id":"mock-b","provider":"mock","reasoning":false,"contextWindow":128000}`)},
	})
	if got := m.overlayCtx.currentModel; got != "mock/mock-b" {
		t.Fatalf("set_model result did not refresh overlayCtx.currentModel: %q", got)
	}

	m.Update(CommandResultMsg{
		Command:  "cycle_model",
		Response: bridge.Response{Success: true, Data: json.RawMessage(`{"id":"mock-a","provider":"mock"}`)},
	})
	if got := m.overlayCtx.currentModel; got != "mock/mock-a" {
		t.Fatalf("cycle_model result did not refresh overlayCtx.currentModel: %q", got)
	}

	m.Update(EventMsg{Event: bridge.Event{Type: "thinking_level_changed", Payload: json.RawMessage(`{"type":"thinking_level_changed","level":"high"}`)}})
	if got := m.overlayCtx.thinkingLevel; got != "high" {
		t.Fatalf("thinking_level_changed did not refresh overlayCtx.thinkingLevel: %q", got)
	}
}
