package app_test

import (
	"encoding/json"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// nopMsg is what fake commander tea.Cmds yield when run.
type nopMsg struct{}

// fakeCommander implements app.Commander, recording each call at tea.Cmd BUILD
// time as "kind:payload". Build-time recording is what the no-flush-before-
// agent_end assertions key on: the Router must not even construct a delivery
// command for a queued follow-up until AgentEnd.
type fakeCommander struct {
	calls []string
}

func (f *fakeCommander) record(entry string) tea.Cmd {
	f.calls = append(f.calls, entry)
	return func() tea.Msg { return nopMsg{} }
}

func (f *fakeCommander) Prompt(message string) tea.Cmd   { return f.record("prompt:" + message) }
func (f *fakeCommander) Steer(message string) tea.Cmd    { return f.record("steer:" + message) }
func (f *fakeCommander) FollowUp(message string) tea.Cmd { return f.record("follow_up:" + message) }
func (f *fakeCommander) AbortBash() tea.Cmd              { return f.record("abort_bash") }

func (f *fakeCommander) Bash(command string, excludeFromContext bool) tea.Cmd {
	entry := "bash:" + command
	if excludeFromContext {
		entry = "bash!!:" + command
	}
	return f.record(entry)
}

func (f *fakeCommander) Request(cmd bridge.Command) tea.Cmd {
	return f.record("request:" + cmd.Type)
}

// callsOfKind returns the recorded calls whose kind prefix matches.
func (f *fakeCommander) callsOfKind(kinds ...string) []string {
	var out []string
	for _, c := range f.calls {
		for _, k := range kinds {
			if strings.HasPrefix(c, k+":") || c == k {
				out = append(out, c)
			}
		}
	}
	return out
}

// fakeEditor implements app.EditorBuffer.
type fakeEditor struct {
	text     string
	history  []string
	provider editor.AutocompleteProvider
}

func (f *fakeEditor) GetText() string          { return f.text }
func (f *fakeEditor) SetText(text string)      { f.text = text }
func (f *fakeEditor) AddToHistory(text string) { f.history = append(f.history, text) }
func (f *fakeEditor) SetAutocompleteProvider(p editor.AutocompleteProvider) {
	f.provider = p
}

// fakeHistory implements app.PromptHistory (the persistence seam).
type fakeHistory struct {
	entries []string
}

func (f *fakeHistory) Append(text string) { f.entries = append(f.entries, text) }

// routerFixture bundles a Router with its injected fakes.
type routerFixture struct {
	router    *app.Router
	queue     *shell.Queue
	commander *fakeCommander
	editor    *fakeEditor
	history   *fakeHistory
}

func newRouterFixture(t *testing.T) *routerFixture {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName, AgentDir: "\x00nonexistent"})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	q := shell.NewQueue()
	c := &fakeCommander{}
	r := app.NewRouter(slash.NewDispatcher(slash.NewBuiltins()), q, c, th)
	fx := &routerFixture{router: r, queue: q, commander: c, editor: &fakeEditor{}, history: &fakeHistory{}}
	r.AttachEditor(fx.editor)
	r.SetHistory(fx.history)
	return fx
}

// queueContents flattens the queue as ["S:<msg>"... , "F:<msg>"...].
func queueContents(q *shell.Queue) []string {
	steering, followUp := q.Messages()
	var out []string
	for _, m := range steering {
		out = append(out, "S:"+m)
	}
	for _, m := range followUp {
		out = append(out, "F:"+m)
	}
	return out
}

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

// ---------------------------------------------------------------------------
// Submit routing table (slash / bang / plain × idle / streaming)
// ---------------------------------------------------------------------------

func TestInputSubmitRoutingTable(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		streaming bool
		known     []bridge.RPCSlashCommand
		wantKind  app.RouteKind
		wantCalls []string // exact expected commander calls
		wantQueue []string // queueContents after submit
	}{
		{
			name:     "empty input is ignored",
			input:    "   ",
			wantKind: app.RouteNone,
		},
		{
			name:     "builtin overlay slash command idle",
			input:    "/hotkeys",
			wantKind: app.RouteOverlay,
		},
		{
			name:      "builtin overlay slash command during streaming",
			input:     "/hotkeys",
			streaming: true,
			wantKind:  app.RouteOverlay,
		},
		{
			name:      "builtin rpc slash command",
			input:     "/compact",
			wantKind:  app.RouteRPC,
			wantCalls: []string{"request:compact"},
		},
		{
			name:     "builtin native slash command",
			input:    "/quit",
			wantKind: app.RouteNative,
		},
		{
			name:      "known dynamic command routes to prompt even while streaming",
			input:     "/mycmd run it",
			streaming: true,
			known:     []bridge.RPCSlashCommand{{Name: "mycmd", Source: "extension"}},
			wantKind:  app.RoutePrompt,
			wantCalls: []string{"prompt:/mycmd run it"},
		},
		{
			name:     "unknown slash command with known set surfaces inline error",
			input:    "/definitely-not-a-command",
			known:    []bridge.RPCSlashCommand{{Name: "mycmd", Source: "extension"}},
			wantKind: app.RouteUnknown,
		},
		{
			name:     "unknown slash command without dynamic knowledge falls through to prompt",
			input:    "/maybe-extension",
			wantKind: app.RoutePrompt,
			wantCalls: []string{
				"prompt:/maybe-extension",
			},
		},
		{
			name:      "bang runs bash",
			input:     "!ls -la",
			wantKind:  app.RouteBash,
			wantCalls: []string{"bash:ls -la"},
		},
		{
			name:      "double bang runs bash excluded from context",
			input:     "!!ls",
			wantKind:  app.RouteBash,
			wantCalls: []string{"bash!!:ls"},
		},
		{
			name:      "bare bang is a prompt",
			input:     "!",
			wantKind:  app.RoutePrompt,
			wantCalls: []string{"prompt:!"},
		},
		{
			name:      "plain text idle prompts",
			input:     "hello there",
			wantKind:  app.RoutePrompt,
			wantCalls: []string{"prompt:hello there"},
		},
		{
			name:      "plain text during streaming enqueues steer",
			input:     "second thought",
			streaming: true,
			wantKind:  app.RouteSteerQueued,
			wantCalls: []string{"steer:second thought"},
			wantQueue: []string{"S:second thought"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newRouterFixture(t)
			if tc.known != nil {
				fx.router.WireAutocomplete(tc.known, t.TempDir(), "")
			}
			fx.router.SetStreaming(tc.streaming)

			res := fx.router.Submit(tc.input)

			if res.Kind != tc.wantKind {
				t.Fatalf("Submit(%q) kind = %v, want %v", tc.input, res.Kind, tc.wantKind)
			}
			if !equalStrings(fx.commander.calls, tc.wantCalls) {
				t.Fatalf("commander calls = %v, want %v", fx.commander.calls, tc.wantCalls)
			}
			if !equalStrings(queueContents(fx.queue), tc.wantQueue) {
				t.Fatalf("queue = %v, want %v", queueContents(fx.queue), tc.wantQueue)
			}
			if len(tc.wantCalls) > 0 && res.Kind != app.RouteNative && res.Cmd == nil {
				t.Fatal("expected a non-nil tea.Cmd carrying the RPC")
			}
		})
	}
}

func TestInputUnknownCommandNotice(t *testing.T) {
	fx := newRouterFixture(t)
	fx.router.WireAutocomplete(nil, t.TempDir(), "")

	res := fx.router.Submit("/nope")
	if res.Kind != app.RouteUnknown {
		t.Fatalf("kind = %v, want RouteUnknown", res.Kind)
	}
	if want := slash.UnknownCommandError("nope"); res.Notice != want {
		t.Fatalf("notice = %q, want %q", res.Notice, want)
	}
}

// ---------------------------------------------------------------------------
// Acceptance: every builtin resolves to a handler or documented overlay route
// ---------------------------------------------------------------------------

func TestInputBuiltinAcceptance(t *testing.T) {
	names := slash.BuiltinNames()
	if len(names) != 22 {
		t.Fatalf("expected 22 builtin slash commands, got %d", len(names))
	}

	// The documented route per builtin: overlay | rpc | native. No stubs.
	wantRoute := map[string]app.RouteKind{
		"settings":        app.RouteOverlay,
		"model":           app.RouteOverlay,
		"favorite-models": app.RouteOverlay,
		"export":          app.RouteRPC,
		"import":          app.RouteRPC,
		"share":           app.RouteRPC,
		"copy":            app.RouteRPC,
		"name":            app.RouteRPC,
		"session":         app.RouteRPC,
		"changelog":       app.RouteNative,
		"hotkeys":         app.RouteOverlay,
		"fork":            app.RouteOverlay,
		"clone":           app.RouteRPC,
		"tree":            app.RouteOverlay,
		"trust":           app.RouteOverlay,
		"login":           app.RouteOverlay,
		"logout":          app.RouteOverlay,
		"new":             app.RouteRPC,
		"compact":         app.RouteRPC,
		"resume":          app.RouteOverlay,
		"reload":          app.RouteNative,
		"quit":            app.RouteNative,
	}

	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			want, ok := wantRoute[name]
			if !ok {
				t.Fatalf("builtin %q has no documented route in this acceptance table", name)
			}
			fx := newRouterFixture(t)
			res := fx.router.Submit("/" + name)
			if res.Kind != want {
				t.Fatalf("Submit(/%s) kind = %v, want %v", name, res.Kind, want)
			}
			switch res.Kind {
			case app.RouteOverlay:
				if res.Overlay == slash.OverlayNone {
					t.Fatalf("/%s resolved to RouteOverlay with OverlayNone (stub)", name)
				}
			case app.RouteRPC:
				if res.Cmd == nil {
					t.Fatalf("/%s resolved to RouteRPC with nil Cmd (stub)", name)
				}
			case app.RouteNative:
				if res.Native == slash.NativeNone {
					t.Fatalf("/%s resolved to RouteNative with NativeNone (stub)", name)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Follow-up + dequeue actions (resolved keybinding action names, never keys)
// ---------------------------------------------------------------------------

func TestInputFollowUpActionQueuesDuringStreaming(t *testing.T) {
	fx := newRouterFixture(t)
	fx.router.SetStreaming(true)
	fx.editor.SetText("do this after")

	res, handled := fx.router.HandleAction("app.message.followUp")
	if !handled {
		t.Fatal("app.message.followUp was not handled")
	}
	if res.Kind != app.RouteFollowUpQueued {
		t.Fatalf("kind = %v, want RouteFollowUpQueued", res.Kind)
	}
	if got := queueContents(fx.queue); !equalStrings(got, []string{"F:do this after"}) {
		t.Fatalf("queue = %v, want the queued follow-up", got)
	}
	if fx.editor.GetText() != "" {
		t.Fatalf("editor not cleared after queueing, text = %q", fx.editor.GetText())
	}
	// Local until agent_end: no delivery command may have been built.
	if calls := fx.commander.callsOfKind("prompt", "follow_up", "steer"); len(calls) != 0 {
		t.Fatalf("follow-up must stay local until agent_end, commander saw %v", calls)
	}
}

func TestInputFollowUpActionIdleActsAsSubmit(t *testing.T) {
	fx := newRouterFixture(t)
	fx.editor.SetText("just send it")

	res, handled := fx.router.HandleAction("app.message.followUp")
	if !handled {
		t.Fatal("app.message.followUp was not handled")
	}
	if res.Kind != app.RoutePrompt {
		t.Fatalf("kind = %v, want RoutePrompt (idle alt+enter acts as plain enter)", res.Kind)
	}
	if !equalStrings(fx.commander.calls, []string{"prompt:just send it"}) {
		t.Fatalf("commander calls = %v", fx.commander.calls)
	}
	if fx.editor.GetText() != "" {
		t.Fatalf("editor not cleared, text = %q", fx.editor.GetText())
	}
}

func TestInputDequeueRestoresAllQueuedMessages(t *testing.T) {
	fx := newRouterFixture(t)
	fx.router.SetStreaming(true)

	fx.router.Submit("steer one") // steering
	fx.editor.SetText("follow one")
	fx.router.HandleAction("app.message.followUp")
	fx.editor.SetText("draft in progress")

	res, handled := fx.router.HandleAction("app.message.dequeue")
	if !handled {
		t.Fatal("app.message.dequeue was not handled")
	}
	if res.Kind != app.RouteDequeued {
		t.Fatalf("kind = %v, want RouteDequeued", res.Kind)
	}
	// restoreQueuedMessagesToEditor order: [...steering, ...followUp], then the
	// current draft, joined with blank lines.
	want := "steer one\n\nfollow one\n\ndraft in progress"
	if fx.editor.GetText() != want {
		t.Fatalf("editor text = %q, want %q", fx.editor.GetText(), want)
	}
	if !fx.queue.IsEmpty() {
		t.Fatalf("queue not emptied by dequeue: %v", queueContents(fx.queue))
	}
}

func TestInputDequeueEmptyQueueNotice(t *testing.T) {
	fx := newRouterFixture(t)

	res, handled := fx.router.HandleAction("app.message.dequeue")
	if !handled {
		t.Fatal("app.message.dequeue was not handled")
	}
	if res.Kind != app.RouteDequeued {
		t.Fatalf("kind = %v, want RouteDequeued", res.Kind)
	}
	if res.Notice != "No queued messages to restore" {
		t.Fatalf("notice = %q", res.Notice)
	}
}

// ---------------------------------------------------------------------------
// Queue flush: agent_end only (classic parity)
// ---------------------------------------------------------------------------

func TestInputQueueFlushOnAgentEndOnly(t *testing.T) {
	fx := newRouterFixture(t)
	fx.router.SetStreaming(true)

	fx.editor.SetText("first follow-up")
	fx.router.HandleAction("app.message.followUp")
	fx.editor.SetText("second follow-up")
	fx.router.HandleAction("app.message.followUp")

	// NO flush before agent_end: nothing delivered yet.
	if calls := fx.commander.callsOfKind("prompt", "follow_up"); len(calls) != 0 {
		t.Fatalf("queue flushed before agent_end: %v", calls)
	}

	cmd := fx.router.AgentEnd()
	if cmd == nil {
		t.Fatal("AgentEnd with queued follow-ups returned nil Cmd")
	}
	// Classic flush pattern: the first queued message starts the next turn as a
	// prompt; the rest queue behind it as follow-ups (FIFO).
	want := []string{"prompt:first follow-up", "follow_up:second follow-up"}
	if got := fx.commander.callsOfKind("prompt", "follow_up"); !equalStrings(got, want) {
		t.Fatalf("flush calls = %v, want %v", got, want)
	}
	if !fx.queue.IsEmpty() {
		t.Fatalf("queue not emptied by agent_end flush: %v", queueContents(fx.queue))
	}
	if fx.router.Streaming() {
		t.Fatal("AgentEnd must mark the router idle")
	}
}

func TestInputAgentEndDropsConsumedSteering(t *testing.T) {
	fx := newRouterFixture(t)
	fx.router.SetStreaming(true)
	fx.router.Submit("steer it")

	steerCalls := fx.commander.callsOfKind("steer")
	if cmd := fx.router.AgentEnd(); cmd != nil {
		t.Fatal("AgentEnd with only steering must return nil (nothing to fire)")
	}
	if !fx.queue.IsEmpty() {
		t.Fatalf("steering not dropped on agent_end: %v", queueContents(fx.queue))
	}
	if got := fx.commander.callsOfKind("steer", "prompt", "follow_up"); !equalStrings(got, steerCalls) {
		t.Fatalf("agent_end re-delivered steering: %v", got)
	}
}

func TestInputAgentEndEmptyQueueIsNil(t *testing.T) {
	fx := newRouterFixture(t)
	fx.router.SetStreaming(true)
	if cmd := fx.router.AgentEnd(); cmd != nil {
		t.Fatal("AgentEnd with an empty queue must return nil")
	}
}

func TestInputSyncSteeringPreservesLocalFollowUps(t *testing.T) {
	fx := newRouterFixture(t)
	fx.router.SetStreaming(true)

	fx.router.Submit("steer a")
	fx.router.Submit("steer b")
	fx.editor.SetText("local follow-up")
	fx.router.HandleAction("app.message.followUp")

	// The daemon consumed "steer a" mid-turn: queue_update now reports only b.
	fx.router.SyncSteering([]string{"steer b"})

	want := []string{"S:steer b", "F:local follow-up"}
	if got := queueContents(fx.queue); !equalStrings(got, want) {
		t.Fatalf("queue after SyncSteering = %v, want %v", got, want)
	}
}

// ---------------------------------------------------------------------------
// Bash block lifecycle
// ---------------------------------------------------------------------------

func bashResultMsg(t *testing.T, output string, exitCode any, cancelled bool) app.CommandResultMsg {
	t.Helper()
	payload := map[string]any{"output": output, "cancelled": cancelled}
	if exitCode != nil {
		payload["exitCode"] = exitCode
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal bash result: %v", err)
	}
	return app.CommandResultMsg{
		Command:  "bash",
		Response: bridge.Response{Type: "response", Command: "bash", Success: true, Data: data},
	}
}

func TestInputBashLifecycle(t *testing.T) {
	fx := newRouterFixture(t)

	res := fx.router.Submit("!echo hi")
	if res.Kind != app.RouteBash {
		t.Fatalf("kind = %v, want RouteBash", res.Kind)
	}
	if !fx.router.IsBashRunning() {
		t.Fatal("bash not marked running after submit")
	}
	block := fx.router.BashBlock()
	if block == nil {
		t.Fatal("no live bash block after submit")
	}
	if block.HeaderPlain() != "$ echo hi" {
		t.Fatalf("block header = %q", block.HeaderPlain())
	}

	if !fx.router.HandleBashResult(bashResultMsg(t, "hi\n", 0, false)) {
		t.Fatal("HandleBashResult did not consume the bash response")
	}
	if fx.router.IsBashRunning() {
		t.Fatal("bash still marked running after completion")
	}
	if got := block.OutputLines(); len(got) == 0 || got[0] != "hi" {
		t.Fatalf("block output = %v, want streamed 'hi'", got)
	}
	if block.StatusPlain() != "" {
		t.Fatalf("clean exit should have empty status, got %q", block.StatusPlain())
	}
}

func TestInputBashFailureAndCancelStatus(t *testing.T) {
	fx := newRouterFixture(t)

	fx.router.Submit("!false")
	fx.router.HandleBashResult(bashResultMsg(t, "", 2, false))
	if got := fx.router.BashBlock().StatusPlain(); got != "(exit 2)" {
		t.Fatalf("failure status = %q, want (exit 2)", got)
	}

	fx.router.Submit("!sleep 987")
	if !fx.router.IsBashRunning() {
		t.Fatal("second bash not running")
	}
	fx.router.HandleBashResult(bashResultMsg(t, "", nil, true))
	if got := fx.router.BashBlock().StatusPlain(); got != "(cancelled)" {
		t.Fatalf("cancel status = %q, want (cancelled)", got)
	}
}

func TestInputBashBusyRejectsSecondCommand(t *testing.T) {
	fx := newRouterFixture(t)

	fx.router.Submit("!sleep 987")
	res := fx.router.Submit("!echo blocked")
	if res.Kind != app.RouteBashBusy {
		t.Fatalf("kind = %v, want RouteBashBusy", res.Kind)
	}
	if res.Notice == "" {
		t.Fatal("busy rejection must carry the classic warning notice")
	}
	// Classic restores the submitted text so the user does not lose it.
	if fx.editor.GetText() != "!echo blocked" {
		t.Fatalf("editor text = %q, want the restored command", fx.editor.GetText())
	}
	if got := fx.commander.callsOfKind("bash", "bash!!"); !equalStrings(got, []string{"bash:sleep 987"}) {
		t.Fatalf("second bash must not reach the wire, calls = %v", got)
	}
}

func TestInputInterruptAbortsRunningBash(t *testing.T) {
	fx := newRouterFixture(t)

	// No bash running: interrupt is NOT claimed (the model's abort path owns it).
	if _, handled := fx.router.HandleAction("app.interrupt"); handled {
		t.Fatal("interrupt claimed with no bash running")
	}

	fx.router.Submit("!sleep 987")
	res, handled := fx.router.HandleAction("app.interrupt")
	if !handled {
		t.Fatal("interrupt not claimed while bash is running")
	}
	if res.Kind != app.RouteAbortBash {
		t.Fatalf("kind = %v, want RouteAbortBash", res.Kind)
	}
	if got := fx.commander.callsOfKind("abort_bash"); !equalStrings(got, []string{"abort_bash"}) {
		t.Fatalf("abort_bash not issued, calls = %v", fx.commander.calls)
	}
}

func TestInputBashResultIgnoresOtherCommands(t *testing.T) {
	fx := newRouterFixture(t)
	fx.router.Submit("!sleep 1")
	msg := app.CommandResultMsg{Command: "compact", Response: bridge.Response{Type: "response", Command: "compact", Success: true}}
	if fx.router.HandleBashResult(msg) {
		t.Fatal("HandleBashResult consumed a non-bash response")
	}
	if !fx.router.IsBashRunning() {
		t.Fatal("bash state clobbered by unrelated response")
	}
}

// ---------------------------------------------------------------------------
// Autocomplete provider wiring + prompt history
// ---------------------------------------------------------------------------

func TestInputAutocompleteProviderWiring(t *testing.T) {
	fx := newRouterFixture(t)

	provider := fx.router.WireAutocomplete(
		[]bridge.RPCSlashCommand{{Name: "mycmd", Description: "demo", Source: "extension"}},
		t.TempDir(), "",
	)
	if provider == nil {
		t.Fatal("WireAutocomplete returned no provider")
	}
	if fx.editor.provider == nil {
		t.Fatal("provider not installed on the editor seam")
	}
	if _, ok := fx.editor.provider.(*slash.CombinedProvider); !ok {
		t.Fatalf("editor provider is %T, want *slash.CombinedProvider", fx.editor.provider)
	}

	// The same get_commands payload feeds dispatch knowledge: known dynamic
	// commands prompt, unknown names surface the inline error.
	if res := fx.router.Submit("/mycmd"); res.Kind != app.RoutePrompt {
		t.Fatalf("known dynamic command kind = %v, want RoutePrompt", res.Kind)
	}
	if res := fx.router.Submit("/nope"); res.Kind != app.RouteUnknown {
		t.Fatalf("unknown command kind = %v, want RouteUnknown", res.Kind)
	}
}

func TestInputHistoryRecording(t *testing.T) {
	fx := newRouterFixture(t)

	fx.router.Submit("plain prompt")
	fx.router.Submit("!echo hi")
	fx.router.Submit("/compact")
	fx.router.Submit("   ") // ignored: never recorded

	fx.router.SetStreaming(true)
	fx.router.Submit("steer msg")
	fx.editor.SetText("follow msg")
	fx.router.HandleAction("app.message.followUp")

	want := []string{"plain prompt", "!echo hi", "/compact", "steer msg", "follow msg"}
	if !equalStrings(fx.editor.history, want) {
		t.Fatalf("editor history = %v, want %v", fx.editor.history, want)
	}
	if !equalStrings(fx.history.entries, want) {
		t.Fatalf("persisted history = %v, want %v", fx.history.entries, want)
	}
}
