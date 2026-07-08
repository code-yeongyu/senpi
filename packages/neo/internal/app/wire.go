package app

import (
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/extui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript"
)

// wire.go holds the swap-safe indirection that lets the whole app graph keep
// working after the recovery loop adopts a fresh *bridge.Client on a daemon
// reconnect. Every seam that issues RPC (the router's Commander, the overlay
// Requester, the extension-UI request doer + responder, the on-demand stats
// requester) reads the CURRENT client/session through a single clientRef, so a
// swap performed on the Update goroutine is observed by the tea.Cmd goroutines
// that call these seams without re-plumbing each collaborator.

// clientRef holds the live client + session adapter, swapped atomically when the
// recovery loop resumes onto a new client (RecoveryResumedMsg).
type clientRef struct {
	mu      sync.Mutex
	client  *bridge.Client
	session *Session
}

func (r *clientRef) get() (*bridge.Client, *Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.client, r.session
}

func (r *clientRef) set(client *bridge.Client, session *Session) {
	r.mu.Lock()
	r.client, r.session = client, session
	r.mu.Unlock()
}

// programHolder is a programSender whose target is filled after tea.NewProgram,
// breaking the build-order cycle: the session pump and the recovery replayer are
// wired to the holder while the program is constructed, then the real program is
// swapped in before Run. Sends before the swap are dropped (nothing is running to
// receive them yet).
type programHolder struct {
	mu sync.Mutex
	p  programSender
}

var _ programSender = (*programHolder)(nil)

func (h *programHolder) Send(msg tea.Msg) {
	h.mu.Lock()
	p := h.p
	h.mu.Unlock()
	if p != nil {
		p.Send(msg)
	}
}

func (h *programHolder) set(p programSender) {
	h.mu.Lock()
	h.p = p
	h.mu.Unlock()
}

// refCommander adapts the current session to the Router's Commander seam,
// re-reading the live session per call so a post-recovery prompt uses the fresh
// client. A nil session (never in a wired program) degrades every call to nil.
type refCommander struct{ ref *clientRef }

var _ Commander = refCommander{}

func (c refCommander) Prompt(message string) tea.Cmd {
	return call(c.ref, func(s *Session) tea.Cmd { return s.Prompt(message) })
}
func (c refCommander) Steer(message string) tea.Cmd {
	return call(c.ref, func(s *Session) tea.Cmd { return s.Steer(message) })
}
func (c refCommander) FollowUp(message string) tea.Cmd {
	return call(c.ref, func(s *Session) tea.Cmd { return s.FollowUp(message) })
}
func (c refCommander) AbortBash() tea.Cmd {
	return call(c.ref, func(s *Session) tea.Cmd { return s.AbortBash() })
}
func (c refCommander) Request(cmd bridge.Command) tea.Cmd {
	return call(c.ref, func(s *Session) tea.Cmd { return s.Request(cmd) })
}
func (c refCommander) Bash(command string, excludeFromContext bool) tea.Cmd {
	return call(c.ref, func(s *Session) tea.Cmd { return s.Bash(command, excludeFromContext) })
}

// call resolves the live session and applies fn; nil when unwired.
func call(ref *clientRef, fn func(*Session) tea.Cmd) tea.Cmd {
	if _, s := ref.get(); s != nil {
		return fn(s)
	}
	return nil
}

// refDoer adapts the current client to the extension-UI request doer (per-call
// timeout; a zero timeout waits indefinitely for the login_start exemption).
type refDoer struct{ ref *clientRef }

var _ ExtUIRequestDoer = refDoer{}

func (d refDoer) Request(cmd bridge.Command, timeout time.Duration) (bridge.Response, error) {
	client, _ := d.ref.get()
	if client == nil {
		return bridge.Response{}, bridge.ErrClientClosed
	}
	return client.Request(cmd, timeout)
}

// refResponder writes an extension_ui_response line over the current client's raw
// send seam, preserving the original request id.
type refResponder struct{ ref *clientRef }

var _ ExtensionUIResponder = refResponder{}

func (r refResponder) RespondExtensionUI(resp bridge.ExtensionUIResponse) error {
	client, _ := r.ref.get()
	if client == nil {
		return bridge.ErrClientClosed
	}
	return client.SendRaw(resp)
}

// refStats adapts the current session to the shell wire's on-demand stats seam:
// the get_session_stats round-trip returns a CommandResultMsg the wire consumes.
type refStats struct{ ref *clientRef }

var _ StatsRequester = refStats{}

func (s refStats) SessionStats() tea.Cmd {
	return call(s.ref, func(sess *Session) tea.Cmd {
		return sess.Request(bridge.Command{Type: "get_session_stats"})
	})
}

// directiveSink routes the extension-UI fire-and-forget directives onto the live
// shell wire, editor, and transcript feed. It runs on the Update goroutine
// (invoked from ExtUI.HandleRequest), so it touches those surfaces directly.
type directiveSink struct {
	wire   *ShellWire
	editor EditorBuffer
	feed   *transcript.Feed
}

var _ DirectiveSink = directiveSink{}

func (d directiveSink) ApplyDirective(dir extui.Directive) {
	switch dir.Kind {
	case extui.DirectiveNotify:
		noticeToFeed(d.feed, dir.Message)
	case extui.DirectiveSetStatus:
		if d.wire == nil {
			return
		}
		if dir.StatusSet {
			d.wire.SetExtensionStatus(dir.StatusKey, dir.StatusText)
		} else {
			d.wire.ClearExtensionStatus(dir.StatusKey)
		}
	case extui.DirectiveSetWidget:
		if d.wire == nil {
			return
		}
		if !dir.WidgetSet {
			d.wire.SetExtensionWidget(dir.WidgetKey, nil, WidgetAboveEditor)
			return
		}
		placement := WidgetAboveEditor
		if dir.WidgetPlacement == "belowEditor" {
			placement = WidgetBelowEditor
		}
		d.wire.SetExtensionWidget(dir.WidgetKey, dir.WidgetLines, placement)
	case extui.DirectiveSetTitle:
		if d.wire == nil {
			return
		}
		if dir.Title == "" {
			d.wire.ClearExtensionTitle()
		} else {
			d.wire.SetExtensionTitle(dir.Title)
		}
	case extui.DirectiveSetEditorText:
		if d.editor != nil {
			d.editor.SetText(dir.EditorText)
		}
	}
}

// replayEntriesMsg carries recovery-resumed entries from the recovery goroutine
// onto the Update loop, where they are folded into the transcript feed.
type replayEntriesMsg struct{ entries []ResumedEntry }

// feedReplayer implements TranscriptReplayer over the live feed + program.
// MarkTurnAborted runs on the Update loop (safe to touch the feed); ReplayEntries
// runs on the recovery goroutine and hands its entries back via program.Send.
type feedReplayer struct {
	feed    *transcript.Feed
	program programSender
}

var _ TranscriptReplayer = feedReplayer{}

func (r feedReplayer) MarkTurnAborted(notice string) {
	r.feed.AbortPending()
	noticeToFeed(r.feed, notice)
}

func (r feedReplayer) ReplayEntries(entries []ResumedEntry) {
	if r.program == nil || len(entries) == 0 {
		return
	}
	r.program.Send(replayEntriesMsg{entries: entries})
}

// noticeToFeed appends a one-line notice to the transcript as a displayed custom
// entry (the feed has no dedicated notice renderer; a custom "notice" entry is
// the additive, classic-compatible surface).
func noticeToFeed(feed *transcript.Feed, text string) {
	if feed == nil || text == "" {
		return
	}
	feed.Apply(transcript.FeedEvent{
		Type: "message_end",
		Message: &transcript.FeedMessage{
			Role:       "custom",
			CustomType: "notice",
			Display:    true,
			Content:    []transcript.MessageContent{{Type: "text", Text: text}},
		},
	})
}
