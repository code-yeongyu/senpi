package shell

import (
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// PendingMessages renders the queued-messages area shown above the editor,
// mirroring interactive-mode.ts updatePendingMessagesDisplay: a leading blank,
// one dim "Steering: <msg>" line per steering message, one dim
// "Follow-up: <msg>" line per follow-up message, then a dim dequeue hint
// "↳ <key> to edit all queued messages". An empty queue renders nothing.
//
// Every line is truncated to width like the classic TruncatedText children so a
// long queued message never overflows the pane.
type PendingMessages struct {
	th          *theme.Theme
	queue       *Queue
	dequeueKey  string
	dequeueHint string
}

// NewPendingMessages builds the pending-messages area. dequeueKey is the
// resolved key display for app.message.dequeue (e.g. "alt+up").
func NewPendingMessages(th *theme.Theme, dequeueKey string) *PendingMessages {
	return &PendingMessages{th: th, dequeueKey: dequeueKey}
}

// SetQueue attaches the queue whose contents are rendered.
func (p *PendingMessages) SetQueue(q *Queue) { p.queue = q }

// SetDequeueKey updates the resolved dequeue key display.
func (p *PendingMessages) SetDequeueKey(key string) { p.dequeueKey = key }

// Render returns the pending-messages lines for the given width, or nil when the
// queue is empty (interactive-mode renders nothing in that case).
func (p *PendingMessages) Render(width int) []string {
	if p.queue == nil || p.queue.IsEmpty() {
		return nil
	}
	steering, followUp := p.queue.Messages()

	dim := func(s string) string { return p.th.TextDim().Render(s) }

	// Leading blank spacer, matching interactive-mode's `new Spacer(1)`.
	lines := make([]string, 0, len(steering)+len(followUp)+2)
	lines = append(lines, "")
	for _, m := range steering {
		lines = append(lines, ui.TruncateToWidth(dim("Steering: "+m), width, dim("...")))
	}
	for _, m := range followUp {
		lines = append(lines, ui.TruncateToWidth(dim("Follow-up: "+m), width, dim("...")))
	}
	hint := "↳ " + p.dequeueKey + " to edit all queued messages"
	lines = append(lines, ui.TruncateToWidth(dim(hint), width, dim("...")))
	return lines
}
