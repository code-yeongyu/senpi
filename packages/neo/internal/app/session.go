package app

import (
	"errors"
	"strings"
	"sync"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
)

// initialFileArgNotice is the exact one-line, non-fatal notice the adapter
// surfaces when @file args are supplied at launch. Launch-time @file expansion is
// not yet implemented (the daemon-side expander is unbuilt); the args are dropped
// rather than sent as an unexpanded `@`-literal prompt, and the user is told to
// re-add them after startup where the interactive editor handles them.
const initialFileArgNotice = "initial @file at launch is not supported under --neo; add it after startup"

// EventMsg carries one demuxed agent/session event into the update loop. The UI
// (todo 3) translates Event.Type into transcript/shell mutations.
type EventMsg struct{ Event bridge.Event }

// ExtensionUIRequestMsg carries an extension_ui_request line into the update loop
// so the overlay layer (todo 6) can render the dialog and reply on stdin.
type ExtensionUIRequestMsg struct{ Request bridge.ExtensionUIRequest }

// ExtensionErrorMsg carries an extension_error line into the update loop. The raw
// message is forwarded verbatim (the Client owns the codec); the consumer decodes
// the extensionPath/event/error fields it needs.
type ExtensionErrorMsg struct{ Message bridge.Message }

// ClientClosedMsg is emitted once the RPC client's read loop stops (the transport
// ended or the child/daemon connection dropped). Err always wraps
// bridge.ErrClientClosed so callers can errors.Is it.
type ClientClosedMsg struct{ Err error }

// NoticeMsg is a non-fatal, one-line notice for the transcript (e.g. the launch
// @file limitation). It carries no error semantics — purely informational.
type NoticeMsg struct{ Text string }

// CommandResultMsg carries the outcome of a command helper's RPC round-trip. The
// UI reacts to streaming via EventMsg; this message surfaces the command's own
// success/error (e.g. a rejected prompt) and is otherwise advisory.
type CommandResultMsg struct {
	Command  string
	Response bridge.Response
	Err      error
}

// BootstrapMsg carries the fanned-in startup state: the session snapshot, the
// available slash commands, and the model catalog. Err is the joined error of any
// of the three sub-requests that failed.
type BootstrapMsg struct {
	State    bridge.Response
	Commands bridge.Response
	Models   bridge.Response
	Err      error
}

// programSender is the subset of *tea.Program the adapter uses to push bridge
// events into the update loop. Tests inject a channel-backed fake.
type programSender interface {
	Send(msg tea.Msg)
}

var _ programSender = (*tea.Program)(nil)

// Session is the app-layer bridge adapter. It owns a bridge.Client, pumps the
// demuxed event stream into the program as typed messages, and exposes thin
// command helpers over Client.Request. It holds NO UI state and never touches the
// JSON codec directly — the Client owns correlation and decoding.
type Session struct {
	client  *bridge.Client
	program programSender
	options bridge.NeoRuntimeOptions
	unsub   func()
}

// NewSession wires the adapter to a live client and program: it subscribes to the
// demuxed message stream and starts the close watcher. The parsed runtime options
// are retained so InitialInputs can deliver launch positional text as a prompt.
func NewSession(client *bridge.Client, program programSender, opts bridge.NeoRuntimeOptions) *Session {
	s := &Session{client: client, program: program, options: opts}
	s.unsub = client.OnMessage(s.pump)
	go s.watchClosed()
	return s
}

// pump routes one demuxed message to the program. It runs on the client's read
// loop, so it must not block; programSender.Send hands off to the update loop.
func (s *Session) pump(msg bridge.Message) {
	switch msg.Kind {
	case bridge.DemuxEvent:
		ev, err := msg.AsEvent()
		if err != nil {
			return
		}
		s.program.Send(EventMsg{Event: ev})
	case bridge.DemuxExtensionUIRequest:
		req, err := msg.AsExtensionUIRequest()
		if err != nil {
			return
		}
		s.program.Send(ExtensionUIRequestMsg{Request: req})
	case bridge.DemuxExtensionError:
		s.program.Send(ExtensionErrorMsg{Message: msg})
	case bridge.DemuxResponse:
		// Correlated responses are consumed by Client.Request; a straggler with no
		// waiter is observability-only and needs no UI message.
	}
}

// watchClosed emits ClientClosedMsg once the read loop stops. The error always
// wraps bridge.ErrClientClosed so the UI can classify the disconnect uniformly.
func (s *Session) watchClosed() {
	<-s.client.Done()
	s.program.Send(ClientClosedMsg{Err: bridge.ErrClientClosed})
}

// Close unsubscribes the pump and closes the underlying client/transport. The
// daemon path's connection lifecycle is owned by the recovery loop (todo 8); this
// is the isolated-path teardown.
func (s *Session) Close() error {
	if s.unsub != nil {
		s.unsub()
	}
	return s.client.Close()
}

// ---------------------------------------------------------------------------
// Command helpers — thin wrappers over Client.Request at the default timeout.
// None of these is an event-completed auth command, so all honor
// bridge.DefaultRequestTimeout (the timeout exemption is for login flows, todo 13).
// ---------------------------------------------------------------------------

// request builds a tea.Cmd that issues cmd and reports the outcome. The command
// executes on the runtime's goroutine, off the update loop.
func (s *Session) request(cmd bridge.Command) tea.Cmd {
	return func() tea.Msg {
		resp, err := s.client.Request(cmd, bridge.DefaultRequestTimeout)
		return CommandResultMsg{Command: cmd.Type, Response: resp, Err: err}
	}
}

// Prompt sends a fresh user turn.
func (s *Session) Prompt(message string) tea.Cmd {
	return s.request(bridge.Command{Type: "prompt", Fields: map[string]any{"message": message}})
}

// Steer injects a mid-turn steer message into the running turn.
func (s *Session) Steer(message string) tea.Cmd {
	return s.request(bridge.Command{Type: "steer", Fields: map[string]any{"message": message}})
}

// FollowUp queues a follow-up message for after the current turn completes.
func (s *Session) FollowUp(message string) tea.Cmd {
	return s.request(bridge.Command{Type: "follow_up", Fields: map[string]any{"message": message}})
}

// Abort aborts the in-flight turn.
func (s *Session) Abort() tea.Cmd {
	return s.request(bridge.Command{Type: "abort"})
}

// AbortBash aborts an in-flight `!`-bash command.
func (s *Session) AbortBash() tea.Cmd {
	return s.request(bridge.Command{Type: "abort_bash"})
}

// SetModel switches the active provider/model.
func (s *Session) SetModel(provider, modelID string) tea.Cmd {
	return s.request(bridge.Command{Type: "set_model", Fields: map[string]any{"provider": provider, "modelId": modelID}})
}

// SetThinkingLevel sets the reasoning effort level.
func (s *Session) SetThinkingLevel(level string) tea.Cmd {
	return s.request(bridge.Command{Type: "set_thinking_level", Fields: map[string]any{"level": level}})
}

// Compact triggers a manual compaction of the conversation.
func (s *Session) Compact() tea.Cmd {
	return s.request(bridge.Command{Type: "compact"})
}

// Bootstrap fans get_state + get_commands + get_available_models out concurrently
// and returns one combined BootstrapMsg. Each sub-request carries its own default
// timeout, so a slow one cannot stall the others.
func (s *Session) Bootstrap() tea.Cmd {
	return func() tea.Msg {
		type result struct {
			resp bridge.Response
			err  error
		}
		run := func(cmdType string) result {
			resp, err := s.client.Request(bridge.Command{Type: cmdType}, bridge.DefaultRequestTimeout)
			return result{resp: resp, err: err}
		}

		var state, commands, models result
		var wg sync.WaitGroup
		wg.Add(3)
		go func() { defer wg.Done(); state = run("get_state") }()
		go func() { defer wg.Done(); commands = run("get_commands") }()
		go func() { defer wg.Done(); models = run("get_available_models") }()
		wg.Wait()

		return BootstrapMsg{
			State:    state.resp,
			Commands: commands.resp,
			Models:   models.resp,
			Err:      errors.Join(state.err, commands.err, models.err),
		}
	}
}

// InitialInputs delivers the launch inputs. Positional text is joined into one
// `prompt` command; @file args at launch are NOT expanded (out of scope) — instead
// the exact non-fatal initialFileArgNotice is surfaced and the args are dropped,
// never sent as an unexpanded `@`-literal prompt. Returns nil when there is
// nothing to deliver.
func (s *Session) InitialInputs() tea.Cmd {
	var cmds []tea.Cmd
	if text := strings.TrimSpace(strings.Join(s.options.Messages, " ")); text != "" {
		cmds = append(cmds, s.Prompt(text))
	}
	if len(s.options.FileArgs) > 0 {
		cmds = append(cmds, notice(initialFileArgNotice))
	}
	if len(cmds) == 0 {
		return nil
	}
	return tea.Batch(cmds...)
}

// notice builds a tea.Cmd that emits a one-line NoticeMsg.
func notice(text string) tea.Cmd {
	return func() tea.Msg { return NoticeMsg{Text: text} }
}
