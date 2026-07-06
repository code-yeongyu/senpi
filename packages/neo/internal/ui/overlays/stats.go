package overlays

import (
	"strconv"

	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// stats.go renders the /session info + stats view from a get_session_stats
// payload. It is a read-only info panel: session id, message count, token usage,
// and the active model, in the grok bordered style.

// SessionStats mirrors the fields of the get_session_stats response the view
// surfaces.
type SessionStats struct {
	SessionID    string
	SessionName  string
	MessageCount int
	InputTokens  int
	OutputTokens int
	Model        string
	CWD          string
}

// SessionStatsView is the session info/stats overlay.
type SessionStatsView struct {
	stats SessionStats
	th    *theme.Theme
}

// NewSessionStats builds the view over a stats payload.
func NewSessionStats(stats SessionStats) *SessionStatsView {
	th, _ := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	return &SessionStatsView{stats: stats, th: th}
}

// HandleKey closes the view on cancel; other keys are ignored (read-only view).
func (o *SessionStatsView) HandleKey(data string, kb *keybindings.Manager, savedText string) Outcome {
	if matches(kb, data, "tui.select.cancel") {
		return cancel(savedText)
	}
	return none()
}

// RenderPlain renders the view without color for content assertions.
func (o *SessionStatsView) RenderPlain(width int) []string { return o.render(width, false) }

// RenderStyled renders the view with grok styling for the QA harness.
func (o *SessionStatsView) RenderStyled(width int) []string { return o.render(width, true) }

func (o *SessionStatsView) render(width int, styled bool) []string {
	style := func(fn func() lipgloss.Style, s string) string {
		if !styled {
			return s
		}
		return fn().Render(s)
	}
	label := func(k, v string) string {
		return style(o.th.TextMuted, padRight(k, 16)) + style(o.th.TextPrimary, v)
	}
	border := ui.NewDynamicBorder(o.th).Render(width)
	if !styled {
		for i, l := range border {
			border[i] = ui.StripANSI(l)
		}
	}
	s := o.stats
	lines := append([]string(nil), border...)
	lines = append(lines, style(o.th.AccentBlue, "Session info"))
	lines = append(lines, "")
	lines = append(lines, label("Session ID", s.SessionID))
	if s.SessionName != "" {
		lines = append(lines, label("Name", s.SessionName))
	}
	if s.CWD != "" {
		lines = append(lines, label("Directory", s.CWD))
	}
	lines = append(lines, label("Messages", strconv.Itoa(s.MessageCount)))
	lines = append(lines, label("Input tokens", strconv.Itoa(s.InputTokens)))
	lines = append(lines, label("Output tokens", strconv.Itoa(s.OutputTokens)))
	lines = append(lines, label("Model", s.Model))
	lines = append(lines, border...)
	return lines
}
