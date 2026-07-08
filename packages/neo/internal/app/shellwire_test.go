package app_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
)

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// fakeStatsRequester counts on-demand stats pulls and answers with a canned
// CommandResultMsg, proving the wire is event-driven + on-demand only.
type fakeStatsRequester struct{ calls int }

func (f *fakeStatsRequester) SessionStats() tea.Cmd {
	f.calls++
	return func() tea.Msg { return app.CommandResultMsg{Command: "get_session_stats"} }
}

// wireHarness bundles a real shell + the wire under test + the stats fake.
type wireHarness struct {
	sh    *shell.Shell
	wire  *app.ShellWire
	stats *fakeStatsRequester
}

func newWireHarness(t *testing.T) *wireHarness {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName, AgentDir: "\x00nonexistent"})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	keys := keybindings.NewManager(nil)
	sh := shell.New(th, "alt+up", "senpi")
	sh.SetWelcome(shell.WelcomeContent{Title: "senpi"})
	stats := &fakeStatsRequester{}
	wire := app.NewShellWire(sh, app.ShellWireConfig{
		Theme:   th,
		Keys:    keys,
		Stats:   stats,
		AppName: "senpi",
		Cwd:     "/home/u/proj",
		Home:    "/home/u",
	})
	return &wireHarness{sh: sh, wire: wire, stats: stats}
}

// wireEvent builds an EventMsg from a raw event JSON line, the same shape the
// bridge codec produces (Payload = full raw object).
func wireEvent(t *testing.T, raw string) app.EventMsg {
	t.Helper()
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(raw), &probe); err != nil {
		t.Fatalf("bad event fixture %q: %v", raw, err)
	}
	return app.EventMsg{Event: bridge.Event{Type: probe.Type, Payload: json.RawMessage(raw)}}
}

// okResponse builds a successful RpcResponse with a raw data payload.
func okResponse(command, data string) bridge.Response {
	return bridge.Response{Type: "response", Command: command, Success: true, Data: json.RawMessage(data)}
}

// plainStatus renders the status stack stripped of SGR for text assertions.
func plainStatus(h *wireHarness) string {
	return ui.StripANSI(strings.Join(h.sh.StatusStack().Render(120), "\n"))
}

// bootstrapReasoningModel seeds the wire with a get_state carrying a reasoning
// model so thinking-level footer assertions have a ":level" suffix to observe.
func bootstrapReasoningModel(h *wireHarness) {
	h.wire.HandleBootstrap(app.BootstrapMsg{
		State: okResponse("get_state", `{"thinkingLevel":"off","steeringMode":"all","followUpMode":"all",`+
			`"sessionId":"s1","model":{"id":"mock-a","provider":"mock","reasoning":true,"contextWindow":200000},`+
			`"messageCount":0,"pendingMessageCount":0,"isStreaming":false,"isCompacting":false,"autoCompactionEnabled":true}`),
		Models: okResponse("get_available_models", `{"models":[{"provider":"mock"},{"provider":"other"},{"provider":"mock"}]}`),
	})
}

// ---------------------------------------------------------------------------
// Event → region state table
// ---------------------------------------------------------------------------

func TestShellWireEventRegionTable(t *testing.T) {
	cases := []struct {
		name   string
		events []string
		check  func(t *testing.T, h *wireHarness)
	}{
		{
			name:   "auto_retry_start renders digit-bearing countdown",
			events: []string{`{"type":"auto_retry_start","attempt":2,"maxAttempts":5,"delayMs":3000,"errorMessage":"overloaded"}`},
			check: func(t *testing.T, h *wireHarness) {
				got := plainStatus(h)
				if !strings.Contains(got, "Retrying (2/5) in 3s") {
					t.Fatalf("expected retry countdown, status was %q", got)
				}
			},
		},
		{
			name: "auto_retry_end clears the retry status",
			events: []string{
				`{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"overloaded"}`,
				`{"type":"auto_retry_end","success":true,"attempt":1}`,
			},
			check: func(t *testing.T, h *wireHarness) {
				if lines := h.sh.StatusStack().Render(120); lines != nil {
					t.Fatalf("expected idle status after auto_retry_end, got %q", lines)
				}
			},
		},
		{
			name:   "compaction_start threshold renders auto-compacting",
			events: []string{`{"type":"compaction_start","reason":"threshold"}`},
			check: func(t *testing.T, h *wireHarness) {
				if got := plainStatus(h); !strings.Contains(got, "Auto-compacting") {
					t.Fatalf("expected auto-compacting status, got %q", got)
				}
			},
		},
		{
			name:   "compaction_start overflow renders overflow message",
			events: []string{`{"type":"compaction_start","reason":"overflow"}`},
			check: func(t *testing.T, h *wireHarness) {
				if got := plainStatus(h); !strings.Contains(got, "Context overflow detected") {
					t.Fatalf("expected overflow status, got %q", got)
				}
			},
		},
		{
			name:   "compaction_progress recovers a missed start",
			events: []string{`{"type":"compaction_progress","reason":"manual","delta":"x"}`},
			check: func(t *testing.T, h *wireHarness) {
				if got := plainStatus(h); !strings.Contains(got, "Compacting context") {
					t.Fatalf("expected compaction status from progress-only stream, got %q", got)
				}
			},
		},
		{
			name: "compaction_end clears the compaction status",
			events: []string{
				`{"type":"compaction_start","reason":"manual"}`,
				`{"type":"compaction_end","reason":"manual","result":null,"aborted":false,"willRetry":false}`,
			},
			check: func(t *testing.T, h *wireHarness) {
				if lines := h.sh.StatusStack().Render(120); lines != nil {
					t.Fatalf("expected idle status after compaction_end, got %q", lines)
				}
			},
		},
		{
			name: "compaction_end does not clear an active retry",
			events: []string{
				`{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"overloaded"}`,
				`{"type":"compaction_end","reason":"manual","result":null,"aborted":false,"willRetry":false}`,
			},
			check: func(t *testing.T, h *wireHarness) {
				if got := plainStatus(h); !strings.Contains(got, "Retrying") {
					t.Fatalf("expected retry status to survive compaction_end, got %q", got)
				}
			},
		},
		{
			name:   "welcome stays before the first turn",
			events: nil,
			check: func(t *testing.T, h *wireHarness) {
				if h.sh.Header(120) == nil {
					t.Fatal("expected welcome header before the first turn")
				}
			},
		},
		{
			name:   "agent_start dismisses the welcome",
			events: []string{`{"type":"agent_start"}`},
			check: func(t *testing.T, h *wireHarness) {
				if lines := h.sh.Header(120); lines != nil {
					t.Fatalf("expected welcome dismissed on first turn, got %d lines", len(lines))
				}
			},
		},
		{
			name:   "session_info_changed updates footer session segment",
			events: []string{`{"type":"session_info_changed","name":"alpha"}`},
			check: func(t *testing.T, h *wireHarness) {
				got := ui.StripANSI(h.sh.Footer().Render(120)[0])
				if !strings.Contains(got, "alpha") {
					t.Fatalf("expected session name in footer, got %q", got)
				}
			},
		},
		{
			name:   "thinking_level_changed refreshes footer right side",
			events: []string{`{"type":"thinking_level_changed","level":"high"}`},
			check: func(t *testing.T, h *wireHarness) {
				got := ui.StripANSI(h.sh.Footer().Render(120)[0])
				if !strings.Contains(got, "mock-a:high") {
					t.Fatalf("expected model:high on footer right side, got %q", got)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newWireHarness(t)
			bootstrapReasoningModel(h)
			for _, raw := range tc.events {
				h.wire.HandleEvent(wireEvent(t, raw))
			}
			tc.check(t, h)
		})
	}
}

// TestShellWireBootstrapResumeDismissesWelcome proves a resumed session (past
// its first turn already: messageCount > 0) never shows the welcome card.
func TestShellWireBootstrapResumeDismissesWelcome(t *testing.T) {
	h := newWireHarness(t)
	h.wire.HandleBootstrap(app.BootstrapMsg{
		State: okResponse("get_state", `{"thinkingLevel":"off","steeringMode":"all","followUpMode":"all",`+
			`"sessionId":"s1","messageCount":4,"pendingMessageCount":0,"isStreaming":false,"isCompacting":false,`+
			`"autoCompactionEnabled":true}`),
	})
	if lines := h.sh.Header(120); lines != nil {
		t.Fatalf("expected welcome dismissed for a resumed session, got %d lines", len(lines))
	}
}

// ---------------------------------------------------------------------------
// Footer text formatting goldens
// ---------------------------------------------------------------------------

func TestShellWireFooterFormattingGolden(t *testing.T) {
	h := newWireHarness(t)
	bootstrapReasoningModel(h)

	handled := h.wire.HandleCommandResult(app.CommandResultMsg{
		Command: "get_session_stats",
		Response: okResponse("get_session_stats", `{"tokens":{"input":12345,"output":678,"cacheRead":200,`+
			`"cacheWrite":50,"total":13273},"cost":0.042,`+
			`"contextUsage":{"tokens":8000,"contextWindow":200000,"percent":4.0}}`),
	})
	if !handled {
		t.Fatal("expected the wire to consume the get_session_stats result")
	}

	const width = 120
	got := ui.StripANSI(h.sh.Footer().Render(width)[0])
	left := "~/proj • ↑12,345 • ↓678 • cache 200/50 • $0.042 • 8,000/200,000 (4.0%) (auto)"
	right := "(mock) mock-a:off"
	pad := width - ui.VisibleWidth(left) - ui.VisibleWidth(right)
	want := left + strings.Repeat(" ", pad) + right
	if got != want {
		t.Fatalf("footer golden mismatch\n got: %q\nwant: %q", got, want)
	}
}

// TestShellWireFooterUnknownContextGolden pins the post-compaction display:
// contextUsage with null tokens/percent renders the "(?)" marker.
func TestShellWireFooterUnknownContextGolden(t *testing.T) {
	h := newWireHarness(t)
	bootstrapReasoningModel(h)

	h.wire.HandleCommandResult(app.CommandResultMsg{
		Command: "get_session_stats",
		Response: okResponse("get_session_stats", `{"tokens":{"input":100,"output":20,"cacheRead":0,`+
			`"cacheWrite":0,"total":120},"cost":0,`+
			`"contextUsage":{"tokens":null,"contextWindow":200000,"percent":null}}`),
	})

	got := ui.StripANSI(h.sh.Footer().Render(120)[0])
	if !strings.Contains(got, "0/200,000 (?) (auto)") {
		t.Fatalf("expected unknown-context marker, footer was %q", got)
	}
}

// ---------------------------------------------------------------------------
// Title state emission
// ---------------------------------------------------------------------------

func TestShellWireTitleStateEmission(t *testing.T) {
	h := newWireHarness(t)

	if got := h.wire.WindowTitle(); got != "senpi - proj" {
		t.Fatalf("initial title = %q, want %q", got, "senpi - proj")
	}

	h.wire.HandleEvent(wireEvent(t, `{"type":"session_info_changed","name":"alpha"}`))
	if got := h.wire.WindowTitle(); got != "senpi - alpha - proj" {
		t.Fatalf("named-session title = %q, want %q", got, "senpi - alpha - proj")
	}

	h.wire.SetExtensionTitle("custom title")
	if got := h.wire.WindowTitle(); got != "custom title" {
		t.Fatalf("extension title = %q, want %q", got, "custom title")
	}

	h.wire.ClearExtensionTitle()
	if got := h.wire.WindowTitle(); got != "senpi - alpha - proj" {
		t.Fatalf("restored title = %q, want %q", got, "senpi - alpha - proj")
	}

	// name: undefined clears the session label (agent-session.ts contract).
	h.wire.HandleEvent(wireEvent(t, `{"type":"session_info_changed"}`))
	if got := h.wire.WindowTitle(); got != "senpi - proj" {
		t.Fatalf("cleared-session title = %q, want %q", got, "senpi - proj")
	}
}

// ---------------------------------------------------------------------------
// On-demand stats after agent_end (event-driven only, no polling)
// ---------------------------------------------------------------------------

func TestShellWireAgentEndRequestsStatsOnDemand(t *testing.T) {
	h := newWireHarness(t)

	if cmd := h.wire.HandleEvent(wireEvent(t, `{"type":"message_update"}`)); cmd != nil {
		t.Fatal("message_update must not trigger a stats refresh")
	}
	if h.stats.calls != 0 {
		t.Fatalf("stats requested %d times before agent_end", h.stats.calls)
	}

	cmd := h.wire.HandleEvent(wireEvent(t, `{"type":"agent_end"}`))
	if cmd == nil {
		t.Fatal("expected a stats-refresh command from agent_end")
	}
	if h.stats.calls != 1 {
		t.Fatalf("stats requested %d times, want 1", h.stats.calls)
	}
	res, ok := cmd().(app.CommandResultMsg)
	if !ok || res.Command != "get_session_stats" {
		t.Fatalf("expected a get_session_stats CommandResultMsg, got %#v", res)
	}
}

// TestShellWireNilStatsRequester proves agent_end degrades to a no-op command
// when no requester is wired (constructor contract, not a panic path).
func TestShellWireNilStatsRequester(t *testing.T) {
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName, AgentDir: "\x00nonexistent"})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	sh := shell.New(th, "alt+up", "senpi")
	wire := app.NewShellWire(sh, app.ShellWireConfig{
		Theme: th, Keys: keybindings.NewManager(nil), AppName: "senpi", Cwd: "/tmp", Home: "/tmp",
	})
	if cmd := wire.HandleEvent(wireEvent(t, `{"type":"agent_end"}`)); cmd != nil {
		t.Fatal("expected nil command from agent_end without a stats requester")
	}
}

// ---------------------------------------------------------------------------
// Retry countdown advance (tick-driven re-render, deadline seeded by the event)
// ---------------------------------------------------------------------------

func TestShellWireRetryCountdownAdvance(t *testing.T) {
	h := newWireHarness(t)
	h.wire.HandleEvent(wireEvent(t, `{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":3000,"errorMessage":"overloaded"}`))
	start := time.Now()

	if got := plainStatus(h); !strings.Contains(got, "in 3s") {
		t.Fatalf("expected seeded countdown of 3s, got %q", got)
	}

	h.wire.AdvanceStatus(start.Add(2 * time.Second))
	if got := plainStatus(h); !strings.Contains(got, "in 1s") {
		t.Fatalf("expected countdown at 1s after two elapsed seconds, got %q", got)
	}

	h.wire.AdvanceStatus(start.Add(10 * time.Second))
	if got := plainStatus(h); !strings.Contains(got, "in 0s") {
		t.Fatalf("expected countdown clamped at 0s past the deadline, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// Extension setStatus / setWidget keyed segments (the todo-9 adapter seam)
// ---------------------------------------------------------------------------

// The wire itself is the directives sink todo 9 adapts extension directives to.
var _ app.ExtensionShellSink = (*app.ShellWire)(nil)

func TestShellWireExtensionStatusSegments(t *testing.T) {
	h := newWireHarness(t)

	h.wire.SetExtensionStatus("linter", "lint: 3 warnings")
	lines := h.sh.Footer().Render(120)
	if len(lines) != 2 {
		t.Fatalf("expected a second footer line for extension statuses, got %d lines", len(lines))
	}
	if got := ui.StripANSI(lines[1]); !strings.Contains(got, "lint: 3 warnings") {
		t.Fatalf("expected extension status text, got %q", got)
	}

	// Keys render sorted, mirroring footer.ts map iteration + sort.
	h.wire.SetExtensionStatus("a-first", "alpha status")
	got := ui.StripANSI(h.sh.Footer().Render(120)[1])
	if !strings.Contains(got, "alpha status lint: 3 warnings") {
		t.Fatalf("expected key-sorted statuses, got %q", got)
	}

	h.wire.ClearExtensionStatus("linter")
	h.wire.ClearExtensionStatus("a-first")
	if lines := h.sh.Footer().Render(120); len(lines) != 1 {
		t.Fatalf("expected the status line to disappear once cleared, got %d lines", len(lines))
	}
}

func TestShellWireExtensionWidgetSegments(t *testing.T) {
	h := newWireHarness(t)

	h.wire.SetExtensionWidget("w1", []string{"above-widget-line"}, app.WidgetAboveEditor)
	above := ui.StripANSI(strings.Join(h.sh.AboveEditor(120), "\n"))
	if !strings.Contains(above, "above-widget-line") {
		t.Fatalf("expected widget above the editor, got %q", above)
	}

	// Re-placing the same key moves it: gone above, present below.
	h.wire.SetExtensionWidget("w1", []string{"below-widget-line"}, app.WidgetBelowEditor)
	above = ui.StripANSI(strings.Join(h.sh.AboveEditor(120), "\n"))
	below := ui.StripANSI(strings.Join(h.sh.BelowEditor(120), "\n"))
	if strings.Contains(above, "widget-line") {
		t.Fatalf("expected widget removed from above-editor after re-place, got %q", above)
	}
	if !strings.Contains(below, "below-widget-line") {
		t.Fatalf("expected widget below the editor, got %q", below)
	}

	// nil lines clears (setWidget(key, undefined) parity).
	h.wire.SetExtensionWidget("w1", nil, app.WidgetBelowEditor)
	below = ui.StripANSI(strings.Join(h.sh.BelowEditor(120), "\n"))
	if strings.Contains(below, "widget-line") {
		t.Fatalf("expected widget cleared, got %q", below)
	}
}

// TestShellWireModelSwitchResultUpdatesFooter proves a successful set_model /
// cycle_model round-trip re-points the footer at the new model (live QA
// regression: after switching mock-a -> mock-b in the /model selector the
// footer stayed on mock-a — no event carries model changes over RPC, so the
// wire must consume the command response itself).
func TestShellWireModelSwitchResultUpdatesFooter(t *testing.T) {
	h := newWireHarness(t)
	h.wire.HandleBootstrap(app.BootstrapMsg{
		State: okResponse("get_state", `{"thinkingLevel":"off","steeringMode":"all","followUpMode":"all",`+
			`"sessionId":"s1","messageCount":0,"pendingMessageCount":0,"isStreaming":false,"isCompacting":false,`+
			`"autoCompactionEnabled":true,"model":{"id":"mock-a","provider":"mock","reasoning":false,"contextWindow":128000}}`),
	})
	if got := ui.StripANSI(h.sh.Footer().Render(120)[0]); !strings.Contains(got, "mock-a") {
		t.Fatalf("bootstrap footer should show mock-a, got: %q", got)
	}

	consumed := h.wire.HandleCommandResult(app.CommandResultMsg{
		Command:  "set_model",
		Response: okResponse("set_model", `{"id":"mock-b","provider":"mock","reasoning":true,"contextWindow":200000}`),
	})
	if !consumed {
		t.Fatalf("set_model result was not consumed by the wire")
	}
	got := ui.StripANSI(h.sh.Footer().Render(120)[0])
	if !strings.Contains(got, "mock-b") || strings.Contains(got, "mock-a") {
		t.Fatalf("footer should show mock-b after set_model, got: %q", got)
	}

	if !h.wire.HandleCommandResult(app.CommandResultMsg{
		Command:  "cycle_model",
		Response: okResponse("cycle_model", `{"id":"mock-a","provider":"mock","reasoning":false,"contextWindow":128000}`),
	}) {
		t.Fatalf("cycle_model result was not consumed by the wire")
	}
	if got := ui.StripANSI(h.sh.Footer().Render(120)[0]); !strings.Contains(got, "mock-a") {
		t.Fatalf("footer should show mock-a after cycle_model, got: %q", got)
	}

	// A null cycle result (no other model) must keep the current footer.
	if !h.wire.HandleCommandResult(app.CommandResultMsg{
		Command:  "cycle_model",
		Response: okResponse("cycle_model", `null`),
	}) {
		t.Fatalf("null cycle_model result should still be consumed")
	}
	if got := ui.StripANSI(h.sh.Footer().Render(120)[0]); !strings.Contains(got, "mock-a") {
		t.Fatalf("footer should keep mock-a after null cycle_model, got: %q", got)
	}
}
