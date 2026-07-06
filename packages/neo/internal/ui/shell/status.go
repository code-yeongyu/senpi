package shell

import (
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// StatusKind enumerates the status-indicator variants, mirroring
// status-indicator.ts StatusIndicatorKind.
type StatusKind int

const (
	// StatusWorking is the default agent-running spinner (accent spinner, muted
	// message).
	StatusWorking StatusKind = iota
	// StatusRetry is the auto-retry countdown (warning spinner).
	StatusRetry
	// StatusCompaction is the context-compaction spinner (accent spinner).
	StatusCompaction
	// StatusBranchSummary is the branch-summary spinner (accent spinner).
	StatusBranchSummary
)

// CompactionReason mirrors status-indicator.ts CompactionStatusReason and
// selects the compaction message text.
type CompactionReason int

const (
	CompactionManual CompactionReason = iota
	CompactionThreshold
	CompactionOverflow
	CompactionPrePrompt
	CompactionBranch
	CompactionExtension
)

// StatusIndicator is a spinner + message line, built on the shared ui.Loader so
// the braille frame family + colorizer contract is identical to the classic
// Loader. Port of status-indicator.ts (StatusIndicator/Working/Retry/Compaction/
// BranchSummary). Retry carries a countdown whose seconds re-render via
// SetRemainingSeconds — the bubbletea tick drives it (there is no Node interval).
type StatusIndicator struct {
	kind   StatusKind
	loader *ui.Loader

	// retry state (only meaningful for StatusRetry).
	attempt     int
	maxAttempts int
	cancelHint  string
	remaining   int
}

// NewStatusIndicator builds a generic (working/compaction/branchSummary)
// indicator with an explicit message.
func NewStatusIndicator(th *theme.Theme, kind StatusKind, message string) *StatusIndicator {
	l := ui.NewLoader(th, message)
	applyStatusColors(th, l, kind)
	return &StatusIndicator{kind: kind, loader: l}
}

// NewRetryStatus builds the retry-countdown indicator (warning spinner, muted
// message). delayMs seeds the initial seconds (ceil). cancelHint is the resolved
// app.interrupt key display (e.g. "esc").
func NewRetryStatus(th *theme.Theme, attempt, maxAttempts int, delayMs int64, cancelHint string) *StatusIndicator {
	seconds := int((delayMs + 999) / 1000)
	l := ui.NewLoader(th, "")
	applyStatusColors(th, l, StatusRetry)
	s := &StatusIndicator{
		kind:        StatusRetry,
		loader:      l,
		attempt:     attempt,
		maxAttempts: maxAttempts,
		cancelHint:  cancelHint,
		remaining:   seconds,
	}
	s.loader.SetMessage(s.retryMessage())
	return s
}

// NewCompactionStatus builds the compaction indicator with the reason-specific
// message (status-indicator.ts CompactionStatusIndicator).
func NewCompactionStatus(th *theme.Theme, reason CompactionReason, cancelHint string) *StatusIndicator {
	hint := "(" + cancelHint + " to cancel)"
	var label string
	switch reason {
	case CompactionOverflow:
		label = "Context overflow detected, compacting... " + hint
	case CompactionPrePrompt:
		label = "Compacting before next prompt... " + hint
	case CompactionThreshold:
		label = "Auto-compacting... " + hint
	default: // manual, branch, extension
		label = "Compacting context... " + hint
	}
	return NewStatusIndicator(th, StatusCompaction, label)
}

// NewBranchSummaryStatus builds the branch-summary indicator.
func NewBranchSummaryStatus(th *theme.Theme, cancelHint string) *StatusIndicator {
	return NewStatusIndicator(th, StatusBranchSummary, "Summarizing branch... ("+cancelHint+" to cancel)")
}

// Kind returns the indicator variant.
func (s *StatusIndicator) Kind() StatusKind { return s.kind }

// Advance advances the spinner frame (driven by the bubbletea tick).
func (s *StatusIndicator) Advance() { s.loader.Advance() }

// SetRemainingSeconds updates the retry countdown seconds and re-renders the
// message. No-op for non-retry indicators.
func (s *StatusIndicator) SetRemainingSeconds(seconds int) {
	if s.kind != StatusRetry {
		return
	}
	s.remaining = seconds
	s.loader.SetMessage(s.retryMessage())
}

func (s *StatusIndicator) retryMessage() string {
	return "Retrying (" + itoaShell(s.attempt) + "/" + itoaShell(s.maxAttempts) + ") in " +
		itoaShell(s.remaining) + "s... (" + s.cancelHint + " to cancel)"
}

// Render returns the single status line for the given width.
func (s *StatusIndicator) Render(width int) []string {
	return s.loader.Render(width)
}

func applyStatusColors(th *theme.Theme, l *ui.Loader, kind StatusKind) {
	msg := func(s string) string { return th.TextMuted().Render(s) }
	var spin func(string) string
	switch kind {
	case StatusRetry:
		spin = func(s string) string { return th.AccentYellow().Render(s) }
	default:
		// working / compaction / branchSummary all use the accent spinner.
		spin = func(s string) string { return th.AccentGreen().Render(s) }
	}
	l.SetColors(spin, msg)
}

// StatusStack holds the single active status indicator (the classic TUI shows
// one at a time; IdleStatus renders two blank lines but neo collapses idle to no
// lines so the shell owns spacing). Set replaces the active indicator; Clear
// returns to idle.
type StatusStack struct {
	th     *theme.Theme
	active *StatusIndicator
}

// NewStatusStack builds an empty (idle) stack.
func NewStatusStack(th *theme.Theme) *StatusStack { return &StatusStack{th: th} }

// Set makes ind the active indicator.
func (s *StatusStack) Set(ind *StatusIndicator) { s.active = ind }

// Active returns the current indicator, or nil when idle.
func (s *StatusStack) Active() *StatusIndicator { return s.active }

// Clear returns the stack to idle.
func (s *StatusStack) Clear() { s.active = nil }

// Advance advances the active indicator's spinner (no-op when idle).
func (s *StatusStack) Advance() {
	if s.active != nil {
		s.active.Advance()
	}
}

// Render returns the active indicator's lines, or nil when idle.
func (s *StatusStack) Render(width int) []string {
	if s.active == nil {
		return nil
	}
	return s.active.Render(width)
}
