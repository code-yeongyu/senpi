package shell

import (
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

// Shell composes the app-shell regions into a single frame region set. It owns
// the presentational pieces the interactive TUI stacks around the transcript +
// editor (interactive-mode.ts container order):
//
//	[welcome (only before first turn)]
//	[widgetAbove]      extension setWidget blocks above the editor
//	[status stack]     spinner / retry / compaction / branch-summary
//	[pending messages] steering / follow-up queue
//	<editor>           owned by the app; the shell frames around it
//	[widgetBelow]      extension setWidget blocks below the editor
//	[footer]           model/cwd/mode HUD + hints
//
// The app Model calls the region accessors and interleaves the editor between
// AboveEditor and BelowEditor. Shell never renders the editor itself (that is
// the editor component's job) — keeping the shell a pure presentational layer.
type Shell struct {
	th *theme.Theme

	welcome     *Welcome
	showWelcome bool
	widgetAbove *WidgetArea
	widgetBelow *WidgetArea
	statusStack *StatusStack
	pending     *PendingMessages
	footer      *Footer
	queue       *Queue
	bellEnabled bool
	appName     string
	sessionName string
	cwd         string
}

// New builds a shell bound to a theme. dequeueKey is the resolved
// app.message.dequeue key display for the pending-messages hint. appName is the
// title app label (e.g. "senpi").
func New(th *theme.Theme, dequeueKey, appName string) *Shell {
	q := NewQueue()
	pending := NewPendingMessages(th, dequeueKey)
	pending.SetQueue(q)
	return &Shell{
		th:          th,
		showWelcome: true,
		widgetAbove: NewWidgetArea(th),
		widgetBelow: NewWidgetArea(th),
		statusStack: NewStatusStack(th),
		pending:     pending,
		footer:      NewFooter(th),
		queue:       q,
		appName:     appName,
	}
}

// SetWelcome installs the welcome content shown before the first turn.
func (s *Shell) SetWelcome(content WelcomeContent) {
	s.welcome = NewWelcome(s.th, content)
}

// DismissWelcome hides the welcome card (called once the first message lands).
func (s *Shell) DismissWelcome() { s.showWelcome = false }

// Queue returns the shared message queue.
func (s *Shell) Queue() *Queue { return s.queue }

// Footer returns the footer component for data updates.
func (s *Shell) Footer() *Footer { return s.footer }

// StatusStack returns the status-indicator stack.
func (s *Shell) StatusStack() *StatusStack { return s.statusStack }

// WidgetAbove / WidgetBelow return the extension widget areas.
func (s *Shell) WidgetAbove() *WidgetArea { return s.widgetAbove }
func (s *Shell) WidgetBelow() *WidgetArea { return s.widgetBelow }

// SetSession updates the session/cwd used for the terminal title.
func (s *Shell) SetSession(sessionName, cwd string) {
	s.sessionName = sessionName
	s.cwd = cwd
}

// SetBellEnabled sets the system-bell policy.
func (s *Shell) SetBellEnabled(enabled bool) { s.bellEnabled = enabled }

// TitleSequence returns the OSC-0 escape for the current normal title.
func (s *Shell) TitleSequence() string {
	return TitleSequence(NormalTitle(s.appName, s.sessionName, s.cwd))
}

// Bell returns the bell escape per the policy (empty when disabled).
func (s *Shell) Bell() string { return BellSequence(s.bellEnabled) }

// Header returns the welcome lines (only before the first turn; nil afterward or
// when no welcome content is set).
func (s *Shell) Header(width int) []string {
	if !s.showWelcome || s.welcome == nil {
		return nil
	}
	return s.welcome.Render(width)
}

// AboveEditor returns everything rendered between the transcript and the editor:
// the above-editor widgets, the status stack, then the pending-messages area.
func (s *Shell) AboveEditor(width int) []string {
	var out []string
	out = append(out, s.widgetAbove.Render(width)...)
	out = append(out, s.statusStack.Render(width)...)
	out = append(out, s.pending.Render(width)...)
	return out
}

// BelowEditor returns the below-editor widgets + footer.
func (s *Shell) BelowEditor(width int) []string {
	var out []string
	out = append(out, s.widgetBelow.Render(width)...)
	out = append(out, s.footer.Render(width)...)
	return out
}
