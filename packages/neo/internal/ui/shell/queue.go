package shell

// Queue is the neo message queue: the steering + follow-up message buffers that
// interactive-mode.ts maintains while the agent is running. Semantics mirror
// interactive-mode.ts (getAllQueuedMessages / clearAllQueues /
// abortAndFireQueuedMessages):
//
//   - Steering messages (alt+enter in steer mode) are delivered to the running
//     turn; follow-up messages (alt+enter in follow-up mode) run after the turn.
//   - Dequeue (alt+up) drains ALL queued messages back to the editor as
//     [...steering, ...followUp] and empties the queue.
//   - agent_end flushes the queue: any steering already consumed during the
//     turn is gone; the remaining follow-up messages fire in FIFO order and the
//     queue empties.
//
// This is a pure state holder — the bubbletea Model owns when to enqueue/flush
// and the RPC prompt() calls; Queue never touches the wire.
type QueueMode int

const (
	// QueueSteering messages steer the currently running turn.
	QueueSteering QueueMode = iota
	// QueueFollowUp messages run after the current turn completes.
	QueueFollowUp
)

// Queue holds the steering and follow-up message buffers.
type Queue struct {
	steering []string
	followUp []string
}

// NewQueue builds an empty queue.
func NewQueue() *Queue { return &Queue{} }

// Enqueue appends a message to the buffer selected by mode (FIFO).
func (q *Queue) Enqueue(text string, mode QueueMode) {
	switch mode {
	case QueueFollowUp:
		q.followUp = append(q.followUp, text)
	default:
		q.steering = append(q.steering, text)
	}
}

// Messages returns copies of the steering and follow-up buffers in FIFO order.
func (q *Queue) Messages() (steering, followUp []string) {
	return cloneStrings(q.steering), cloneStrings(q.followUp)
}

// Len returns the total number of queued messages.
func (q *Queue) Len() int { return len(q.steering) + len(q.followUp) }

// IsEmpty reports whether the queue holds no messages.
func (q *Queue) IsEmpty() bool { return q.Len() == 0 }

// Dequeue drains ALL queued messages and clears the queue, returning them as
// [...steering, ...followUp] — the order interactive-mode restores to the
// editor (restoreQueuedMessagesToEditor).
func (q *Queue) Dequeue() []string {
	if q.IsEmpty() {
		return nil
	}
	out := make([]string, 0, q.Len())
	out = append(out, q.steering...)
	out = append(out, q.followUp...)
	q.steering = nil
	q.followUp = nil
	return out
}

// FlushOnAgentEnd fires the remaining follow-up messages (steering was consumed
// during the turn) in FIFO order and clears the queue. Returns the fired
// follow-up messages. This mirrors the agent_end path where queued follow-ups
// are sent to the next turn.
func (q *Queue) FlushOnAgentEnd() []string {
	fired := cloneStrings(q.followUp)
	q.steering = nil
	q.followUp = nil
	return fired
}

func cloneStrings(s []string) []string {
	if len(s) == 0 {
		return nil
	}
	out := make([]string, len(s))
	copy(out, s)
	return out
}
