package shell

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// loadTheme is the grok-night default used by every shell test.
func loadTheme(t *testing.T) *theme.Theme {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	return th
}

// joinPlain strips ANSI and joins lines so structural assertions run on the
// visible text (the grid-level color assertions live in the golden tests +
// xterm harness manifest, per the EVIDENCE FORMAT RULE).
func joinPlain(lines []string) string {
	plain := make([]string, len(lines))
	for i, l := range lines {
		plain[i] = ui.StripANSI(l)
	}
	return strings.Join(plain, "\n")
}

// ---------------------------------------------------------------------------
// Queue state machine (plan task 10 acceptance: enqueue/dequeue/flush on
// agent_end). Mirrors interactive-mode.ts steering/follow-up queue semantics:
//   - steering messages queue while the agent is streaming (alt+enter in steer
//     mode); follow-up messages queue to run after the current turn.
//   - dequeue (alt+up) drains ALL queued messages back to the editor and clears
//     the queue.
//   - agent_end flushes the queue: follow-up messages fire; the queue empties.
// ---------------------------------------------------------------------------

func TestQueueEnqueueSteeringAndFollowUp(t *testing.T) {
	q := NewQueue()
	q.Enqueue("steer-1", QueueSteering)
	q.Enqueue("follow-1", QueueFollowUp)
	q.Enqueue("steer-2", QueueSteering)

	steering, followUp := q.Messages()
	if want := []string{"steer-1", "steer-2"}; !equalStrings(steering, want) {
		t.Errorf("steering = %v, want %v", steering, want)
	}
	if want := []string{"follow-1"}; !equalStrings(followUp, want) {
		t.Errorf("followUp = %v, want %v", followUp, want)
	}
	if q.Len() != 3 {
		t.Errorf("Len = %d, want 3", q.Len())
	}
	if q.IsEmpty() {
		t.Error("IsEmpty = true, want false")
	}
}

func TestQueueDequeueDrainsAllAndClears(t *testing.T) {
	q := NewQueue()
	q.Enqueue("steer-1", QueueSteering)
	q.Enqueue("follow-1", QueueFollowUp)

	// Dequeue returns steering messages first, then follow-up (interactive-mode
	// restoreQueuedMessagesToEditor: [...steering, ...followUp]).
	drained := q.Dequeue()
	if want := []string{"steer-1", "follow-1"}; !equalStrings(drained, want) {
		t.Errorf("Dequeue = %v, want %v", drained, want)
	}
	if !q.IsEmpty() {
		t.Errorf("queue not empty after dequeue: %d", q.Len())
	}
	// Second dequeue on an empty queue returns nothing.
	if got := q.Dequeue(); len(got) != 0 {
		t.Errorf("second Dequeue = %v, want empty", got)
	}
}

func TestQueueFlushOnAgentEndFiresFollowUpAndClears(t *testing.T) {
	q := NewQueue()
	q.Enqueue("steer-1", QueueSteering)
	q.Enqueue("follow-1", QueueFollowUp)
	q.Enqueue("follow-2", QueueFollowUp)

	// Flush = what interactive-mode does at agent_end: steering was already
	// consumed during the turn; the remaining follow-up messages fire in order,
	// and the whole queue clears.
	fired := q.FlushOnAgentEnd()
	if want := []string{"follow-1", "follow-2"}; !equalStrings(fired, want) {
		t.Errorf("FlushOnAgentEnd = %v, want %v", fired, want)
	}
	if !q.IsEmpty() {
		t.Errorf("queue not empty after flush: %d", q.Len())
	}
}

func TestQueueFlushEmptyIsNoop(t *testing.T) {
	q := NewQueue()
	if got := q.FlushOnAgentEnd(); len(got) != 0 {
		t.Errorf("FlushOnAgentEnd on empty = %v, want empty", got)
	}
}

// ---------------------------------------------------------------------------
// Pending-messages display (interactive-mode.ts updatePendingMessagesDisplay):
// "Steering: <msg>" then "Follow-up: <msg>" lines in dim, plus a dequeue hint.
// Empty queue renders nothing.
// ---------------------------------------------------------------------------

func TestPendingMessagesDisplayEmpty(t *testing.T) {
	th := loadTheme(t)
	q := NewQueue()
	pm := NewPendingMessages(th, "alt+up")
	pm.SetQueue(q)
	if lines := pm.Render(80); len(lines) != 0 {
		t.Errorf("empty pending display rendered %d lines, want 0", len(lines))
	}
}

func TestPendingMessagesDisplayLabels(t *testing.T) {
	th := loadTheme(t)
	q := NewQueue()
	q.Enqueue("keep going", QueueSteering)
	q.Enqueue("then this", QueueFollowUp)
	pm := NewPendingMessages(th, "alt+up")
	pm.SetQueue(q)

	out := joinPlain(pm.Render(80))
	if !strings.Contains(out, "Steering: keep going") {
		t.Errorf("missing steering line:\n%s", out)
	}
	if !strings.Contains(out, "Follow-up: then this") {
		t.Errorf("missing follow-up line:\n%s", out)
	}
	if !strings.Contains(out, "alt+up") {
		t.Errorf("missing dequeue hint key:\n%s", out)
	}
	if !strings.Contains(out, "to edit all queued messages") {
		t.Errorf("missing dequeue hint text:\n%s", out)
	}
}

// ---------------------------------------------------------------------------
// Footer (components/footer.ts): left = cwd • [branch] • [session] • tokens •
// cache • cost • context%; right = (provider) model:thinking. cwd is
// home-relativized. Context% colored by threshold. Truncation never overflows.
// ---------------------------------------------------------------------------

func TestFooterLeftSegmentsOrderAndContent(t *testing.T) {
	th := loadTheme(t)
	f := NewFooter(th)
	f.SetData(FooterData{
		Cwd:             "/tmp/proj",
		Home:            "/tmp",
		GitBranch:       "main",
		SessionName:     "work",
		TokensInput:     1234,
		TokensOutput:    56,
		CacheRead:       10,
		CacheWrite:      20,
		Cost:            0.125,
		ContextTokens:   4000,
		ContextWindow:   200000,
		ContextPct:      2.0,
		ContextPctKnown: true,
		AutoCompact:     true,
		ModelID:         "composer-2.5",
	})
	out := joinPlain(f.Render(120))

	// cwd relativized to ~ under home.
	if !strings.Contains(out, "~/proj") {
		t.Errorf("cwd not home-relativized:\n%s", out)
	}
	for _, want := range []string{"main", "work", "↑1,234", "↓56", "cache 10/20", "$0.125", "composer-2.5"} {
		if !strings.Contains(out, want) {
			t.Errorf("footer missing %q:\n%s", want, out)
		}
	}
	// context display uses the (auto) suffix + percent.
	if !strings.Contains(out, "(2.0%)") || !strings.Contains(out, "(auto)") {
		t.Errorf("footer context display wrong:\n%s", out)
	}
}

func TestFooterModelWithThinking(t *testing.T) {
	th := loadTheme(t)
	f := NewFooter(th)
	f.SetData(FooterData{
		Cwd:           "/tmp",
		Home:          "/tmp",
		ModelID:       "opus-4.8",
		ModelReasons:  true,
		ThinkingLevel: "high",
		ContextWindow: 200000,
	})
	out := joinPlain(f.Render(120))
	if !strings.Contains(out, "opus-4.8:high") {
		t.Errorf("footer thinking suffix wrong:\n%s", out)
	}
}

func TestFooterThinkingOffSuffix(t *testing.T) {
	th := loadTheme(t)
	f := NewFooter(th)
	f.SetData(FooterData{
		Cwd:           "/tmp",
		Home:          "/tmp",
		ModelID:       "opus-4.8",
		ModelReasons:  true,
		ThinkingLevel: "off",
		ContextWindow: 200000,
	})
	out := joinPlain(f.Render(120))
	if !strings.Contains(out, "opus-4.8:off") {
		t.Errorf("footer off suffix wrong:\n%s", out)
	}
}

func TestFooterExtensionStatusesSortedSecondLine(t *testing.T) {
	th := loadTheme(t)
	f := NewFooter(th)
	f.SetData(FooterData{Cwd: "/tmp", Home: "/tmp", ModelID: "m", ContextWindow: 1000})
	f.SetExtensionStatuses(map[string]string{"zeta": "Z-status", "alpha": "A-status"})
	lines := f.Render(120)
	if len(lines) < 2 {
		t.Fatalf("expected 2 footer lines, got %d", len(lines))
	}
	statusLine := ui.StripANSI(lines[1])
	// alpha sorts before zeta.
	ai := strings.Index(statusLine, "A-status")
	zi := strings.Index(statusLine, "Z-status")
	if ai < 0 || zi < 0 || ai > zi {
		t.Errorf("extension statuses not sorted: %q", statusLine)
	}
}

func TestFooterNeverExceedsWidth(t *testing.T) {
	th := loadTheme(t)
	f := NewFooter(th)
	f.SetData(FooterData{
		Cwd:           "/very/long/path/that/keeps/going/and/going/deeper/still",
		Home:          "/home/u",
		SessionName:   "a-fairly-long-session-name-here",
		TokensInput:   9999999,
		TokensOutput:  8888888,
		ModelID:       "a-very-long-model-identifier-string",
		ContextWindow: 200000,
	})
	for _, w := range []int{80, 60, 40} {
		for _, l := range f.Render(w) {
			if got := ui.VisibleWidth(l); got > w {
				t.Errorf("footer line width %d > %d at w=%d: %q", got, w, w, ui.StripANSI(l))
			}
		}
	}
}

func TestFooterContextThresholdColors(t *testing.T) {
	th := loadTheme(t)
	// >90 → error, >70 → warning, else muted. Assert via the palette hex in the
	// rendered SGR (truecolor default path).
	cases := []struct {
		pct float64
		hex string
	}{
		{95, th.Palette().AccentRed},
		{80, th.Palette().AccentYellow},
		{10, th.Palette().TextMuted},
	}
	for _, c := range cases {
		f := NewFooter(th)
		f.SetData(FooterData{Cwd: "/t", Home: "/t", ModelID: "m", ContextWindow: 1000, ContextPct: c.pct})
		joined := strings.Join(f.Render(120), "")
		if !strings.Contains(joined, hexToSGRFg(c.hex)) {
			t.Errorf("pct=%.0f: context color %s not applied", c.pct, c.hex)
		}
	}
}

// ---------------------------------------------------------------------------
// Status indicator stack (status-indicator.ts): working/retry/compaction/
// branchSummary kinds; retry carries a countdown that re-renders the seconds.
// ---------------------------------------------------------------------------

func TestStatusWorkingLine(t *testing.T) {
	th := loadTheme(t)
	s := NewStatusIndicator(th, StatusWorking, "Thinking...")
	out := joinPlain(s.Render(80))
	if !strings.Contains(out, "Thinking...") {
		t.Errorf("working status missing message:\n%s", out)
	}
	// a spinner frame should be present (one of the braille frames).
	if !strings.ContainsAny(out, "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏") {
		t.Errorf("working status missing spinner glyph:\n%s", out)
	}
}

func TestStatusRetryCountdown(t *testing.T) {
	th := loadTheme(t)
	s := NewRetryStatus(th, 2, 5, 3000, "esc")
	out := joinPlain(s.Render(80))
	if !strings.Contains(out, "Retrying (2/5)") {
		t.Errorf("retry message wrong:\n%s", out)
	}
	if !strings.Contains(out, "in 3s") {
		t.Errorf("retry initial countdown wrong:\n%s", out)
	}
	if !strings.Contains(out, "esc") {
		t.Errorf("retry cancel hint missing:\n%s", out)
	}
	// tick down one second.
	s.SetRemainingSeconds(2)
	out = joinPlain(s.Render(80))
	if !strings.Contains(out, "in 2s") {
		t.Errorf("retry countdown not updated:\n%s", out)
	}
}

func TestStatusCompactionReasons(t *testing.T) {
	th := loadTheme(t)
	cases := map[CompactionReason]string{
		CompactionManual:    "Compacting context...",
		CompactionOverflow:  "Context overflow detected, compacting...",
		CompactionPrePrompt: "Compacting before next prompt...",
		CompactionThreshold: "Auto-compacting...",
	}
	for reason, want := range cases {
		s := NewCompactionStatus(th, reason, "esc")
		out := joinPlain(s.Render(80))
		if !strings.Contains(out, want) {
			t.Errorf("compaction reason %v: want %q in\n%s", reason, want, out)
		}
	}
}

func TestStatusBranchSummary(t *testing.T) {
	th := loadTheme(t)
	s := NewBranchSummaryStatus(th, "esc")
	out := joinPlain(s.Render(80))
	if !strings.Contains(out, "Summarizing branch...") {
		t.Errorf("branch summary message wrong:\n%s", out)
	}
}

func TestStatusStackIdleRendersNothing(t *testing.T) {
	th := loadTheme(t)
	stack := NewStatusStack(th)
	if lines := stack.Render(80); len(lines) != 0 {
		t.Errorf("idle stack rendered %d lines, want 0", len(lines))
	}
}

func TestStatusStackShowsActive(t *testing.T) {
	th := loadTheme(t)
	stack := NewStatusStack(th)
	stack.Set(NewStatusIndicator(th, StatusWorking, "Working..."))
	out := joinPlain(stack.Render(80))
	if !strings.Contains(out, "Working...") {
		t.Errorf("active status not shown:\n%s", out)
	}
	stack.Clear()
	if lines := stack.Render(80); len(lines) != 0 {
		t.Errorf("cleared stack rendered %d lines, want 0", len(lines))
	}
}

// ---------------------------------------------------------------------------
// Extension widget areas (setWidget keyed line blocks above/below editor).
// ---------------------------------------------------------------------------

func TestWidgetAreaKeyedBlocks(t *testing.T) {
	th := loadTheme(t)
	w := NewWidgetArea(th)
	w.Set("a", []string{"line-a1", "line-a2"})
	w.Set("b", []string{"line-b1"})
	out := joinPlain(w.Render(80))
	for _, want := range []string{"line-a1", "line-a2", "line-b1"} {
		if !strings.Contains(out, want) {
			t.Errorf("widget area missing %q:\n%s", want, out)
		}
	}
	// keys render in sorted order (deterministic).
	if strings.Index(out, "line-a1") > strings.Index(out, "line-b1") {
		t.Errorf("widget keys not sorted:\n%s", out)
	}
	// clearing a key removes its block.
	w.Clear("a")
	out = joinPlain(w.Render(80))
	if strings.Contains(out, "line-a1") {
		t.Errorf("cleared widget still present:\n%s", out)
	}
	if !strings.Contains(out, "line-b1") {
		t.Errorf("remaining widget dropped:\n%s", out)
	}
}

func TestWidgetAreaEmpty(t *testing.T) {
	th := loadTheme(t)
	w := NewWidgetArea(th)
	if lines := w.Render(80); len(lines) != 0 {
		t.Errorf("empty widget area rendered %d lines, want 0", len(lines))
	}
}

// ---------------------------------------------------------------------------
// Terminal title (tui/terminal.ts setTitle): OSC 0 ... BEL, control chars
// stripped so the title cannot terminate the OSC early.
// ---------------------------------------------------------------------------

func TestTerminalTitleOSC(t *testing.T) {
	got := TitleSequence("senpi - myproj")
	want := "\x1b]0;senpi - myproj\x07"
	if got != want {
		t.Errorf("TitleSequence = %q, want %q", got, want)
	}
}

func TestTerminalTitleStripsControlChars(t *testing.T) {
	// A BEL embedded in the title must be removed, else it would end the OSC.
	got := TitleSequence("bad\x07title\x1bhere\nx")
	// body is everything between the OSC-0 prefix (\x1b]0;) and the terminating
	// BEL; guard against a short/empty stub return so the assertion (not a slice
	// panic) is what fails during RED.
	if body := strings.TrimSuffix(strings.TrimPrefix(got, "\x1b]0;"), "\x07"); strings.Contains(body, "\x07") {
		t.Errorf("title body still contains BEL: %q", got)
	}
	want := "\x1b]0;badtitleherex\x07"
	if got != want {
		t.Errorf("TitleSequence = %q, want %q", got, want)
	}
}

func TestNormalTitleFormat(t *testing.T) {
	// senpi - <session> - <cwd-basename> when a session name is set; otherwise
	// senpi - <cwd-basename>.
	if got := NormalTitle("senpi", "work", "/a/b/proj"); got != "senpi - work - proj" {
		t.Errorf("NormalTitle with session = %q", got)
	}
	if got := NormalTitle("senpi", "", "/a/b/proj"); got != "senpi - proj" {
		t.Errorf("NormalTitle no session = %q", got)
	}
}

// ---------------------------------------------------------------------------
// Notification + system-bell policy (interactive-mode showExtensionNotify +
// settings-driven bell). info→status, warning→warning, error→error; bell
// emitted only when the policy allows.
// ---------------------------------------------------------------------------

func TestNotifyLevelRouting(t *testing.T) {
	cases := map[NotifyLevel]NotifyLevel{
		NotifyInfo:    NotifyInfo,
		NotifyWarning: NotifyWarning,
		NotifyError:   NotifyError,
	}
	for in, want := range cases {
		if got := RouteNotify(in); got != want {
			t.Errorf("RouteNotify(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestBellPolicy(t *testing.T) {
	// bell enabled → BEL sequence; disabled → empty.
	if got := BellSequence(true); got != "\x07" {
		t.Errorf("BellSequence(true) = %q, want BEL", got)
	}
	if got := BellSequence(false); got != "" {
		t.Errorf("BellSequence(false) = %q, want empty", got)
	}
}

// ---------------------------------------------------------------------------
// Welcome card reflow (plan task 10 acceptance: golden frames at 120x36 +
// 80x24). At 120: a bordered card with the braille logo on the left and a right
// column (title+version, announcement, menu). At 80: no border card — compact
// centered menu + announcement, and the version at the bottom-right.
// ---------------------------------------------------------------------------

func welcomeContent() WelcomeContent {
	return WelcomeContent{
		Title:   "Grok Build Beta",
		Version: "0.2.82 [stable]",
		Announcement: Announcement{
			Heading: "Composer 2.5 is here!",
			Body:    "Cursor's latest model is now available. Try it out in the /model picker.",
		},
		Menu: []MenuEntry{
			{Label: "New worktree", Key: "ctrl+w"},
			{Label: "Resume session", Key: "ctrl+s"},
			{Label: "Changelog"},
			{Label: "Quit", Key: "ctrl+q"},
		},
	}
}

func TestWelcomeWideHasBorderedCard(t *testing.T) {
	th := loadTheme(t)
	w := NewWelcome(th, welcomeContent())
	out := joinPlain(w.Render(120))
	// bordered card corners present.
	if !strings.Contains(out, "╭") || !strings.Contains(out, "╮") ||
		!strings.Contains(out, "╰") || !strings.Contains(out, "╯") {
		t.Errorf("wide welcome missing card border:\n%s", out)
	}
	// braille logo present (any braille block glyph).
	if !strings.ContainsAny(out, "⣀⣾⡟⣿⢹⣷⢶⣶") {
		t.Errorf("wide welcome missing braille logo:\n%s", out)
	}
	for _, want := range []string{"Grok Build Beta", "0.2.82 [stable]", "Composer 2.5 is here!", "New worktree", "ctrl+w", "Quit", "ctrl+q"} {
		if !strings.Contains(out, want) {
			t.Errorf("wide welcome missing %q:\n%s", want, out)
		}
	}
}

func TestWelcomeNarrowIsCompactNoBorder(t *testing.T) {
	th := loadTheme(t)
	w := NewWelcome(th, welcomeContent())
	out := joinPlain(w.Render(80))
	// no bordered card corners at narrow width.
	if strings.Contains(out, "╭") || strings.Contains(out, "╮") {
		t.Errorf("narrow welcome should not draw a bordered card:\n%s", out)
	}
	// menu + announcement still present, and the version line present.
	for _, want := range []string{"New worktree", "ctrl+w", "Composer 2.5 is here!", "Grok Build Beta", "0.2.82 [stable]"} {
		if !strings.Contains(out, want) {
			t.Errorf("narrow welcome missing %q:\n%s", want, out)
		}
	}
}

func TestWelcomeNarrowVersionBottomRight(t *testing.T) {
	th := loadTheme(t)
	w := NewWelcome(th, welcomeContent())
	lines := w.Render(80)
	// find the version line; it must be right-aligned (trailing content, leading
	// pad) and be the last non-empty line.
	var versionLineIdx = -1
	for i, l := range lines {
		if strings.Contains(ui.StripANSI(l), "0.2.82") {
			versionLineIdx = i
		}
	}
	if versionLineIdx < 0 {
		t.Fatalf("no version line in narrow welcome")
	}
	vline := ui.StripANSI(lines[versionLineIdx])
	// right-aligned: the version text ends at/near the right edge with leading
	// spaces (more leading than trailing space).
	trimmedRight := strings.TrimRight(vline, " ")
	leading := len(vline) - len(strings.TrimLeft(vline, " "))
	trailing := len(vline) - len(trimmedRight)
	if leading <= trailing {
		t.Errorf("version line not right-aligned (leading=%d trailing=%d): %q", leading, trailing, vline)
	}
}

// ---------------------------------------------------------------------------
// Shell coordinator: region composition (welcome/widgets/status/pending/footer)
// + title/bell wiring. The editor is NOT rendered by the shell.
// ---------------------------------------------------------------------------

func TestShellHeaderShownThenDismissed(t *testing.T) {
	th := loadTheme(t)
	s := New(th, "alt+up", "senpi")
	s.SetWelcome(welcomeContent())
	if lines := s.Header(120); len(lines) == 0 {
		t.Error("header empty before first turn, want welcome")
	}
	s.DismissWelcome()
	if lines := s.Header(120); len(lines) != 0 {
		t.Errorf("header still shown after dismiss: %d lines", len(lines))
	}
}

func TestShellAboveEditorComposesRegions(t *testing.T) {
	th := loadTheme(t)
	s := New(th, "alt+up", "senpi")
	s.WidgetAbove().Set("ext", []string{"widget-above-line"})
	s.StatusStack().Set(NewStatusIndicator(th, StatusWorking, "Working..."))
	s.Queue().Enqueue("steer me", QueueSteering)

	out := joinPlain(s.AboveEditor(80))
	for _, want := range []string{"widget-above-line", "Working...", "Steering: steer me"} {
		if !strings.Contains(out, want) {
			t.Errorf("AboveEditor missing %q:\n%s", want, out)
		}
	}
}

func TestShellBelowEditorHasWidgetsThenFooter(t *testing.T) {
	th := loadTheme(t)
	s := New(th, "alt+up", "senpi")
	s.WidgetBelow().Set("ext", []string{"widget-below-line"})
	s.Footer().SetData(FooterData{Cwd: "/srv/app", Home: "/home/u", ModelID: "footer-model", ContextWindow: 1000})
	lines := s.BelowEditor(80)
	out := joinPlain(lines)
	if !strings.Contains(out, "widget-below-line") {
		t.Errorf("BelowEditor missing widget:\n%s", out)
	}
	if !strings.Contains(out, "footer-model") {
		t.Errorf("BelowEditor missing footer model:\n%s", out)
	}
	// widget renders before the footer.
	if strings.Index(out, "widget-below-line") > strings.Index(out, "footer-model") {
		t.Errorf("widget should render above footer:\n%s", out)
	}
}

func TestShellTitleAndBell(t *testing.T) {
	th := loadTheme(t)
	s := New(th, "alt+up", "senpi")
	s.SetSession("my-session", "/a/b/proj")
	if got := s.TitleSequence(); got != "\x1b]0;senpi - my-session - proj\x07" {
		t.Errorf("shell title = %q", got)
	}
	s.SetBellEnabled(false)
	if got := s.Bell(); got != "" {
		t.Errorf("bell should be silent when disabled: %q", got)
	}
	s.SetBellEnabled(true)
	if got := s.Bell(); got != "\x07" {
		t.Errorf("bell should ring when enabled: %q", got)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// hexToSGRFg converts #rrggbb to its truecolor foreground SGR body
// "38;2;r;g;b" so a test can assert the color was applied on the default
// (truecolor) render path.
func hexToSGRFg(hex string) string {
	r, g, b := parseHex(hex)
	return "38;2;" + itoa(r) + ";" + itoa(g) + ";" + itoa(b)
}

func parseHex(hex string) (int, int, int) {
	hex = strings.TrimPrefix(hex, "#")
	if len(hex) != 6 {
		return 0, 0, 0
	}
	return hexByte(hex[0:2]), hexByte(hex[2:4]), hexByte(hex[4:6])
}

func hexByte(s string) int {
	v := 0
	for _, c := range s {
		v *= 16
		switch {
		case c >= '0' && c <= '9':
			v += int(c - '0')
		case c >= 'a' && c <= 'f':
			v += int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			v += int(c-'A') + 10
		}
	}
	return v
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [4]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
