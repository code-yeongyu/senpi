package app

import (
	"encoding/json"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash"
)

// input.go is the todo-4 editor + queue wiring: the Router classifies every
// editor submission through the slash Dispatcher and routes it to the right
// surface — builtin slash actions (overlay intents / direct RPC / native ops),
// `!` bash mode with a streaming BashBlock + abort_bash on interrupt, and plain
// prompts that queue as steering / follow-up while a turn is streaming. The
// queue holder is the shared shell.Queue (the pending-messages display renders
// it), and classic parity is preserved: NOTHING flushes before agent_end —
// steering is delivered to the running turn immediately (steer RPC, the local
// entry mirrors it for the pending display), follow-ups stay local until
// AgentEnd fires them into the next turn.
//
// Key-triggered behavior (follow-up queueing, dequeue, bash interrupt) resolves
// through keybinding Manager ACTION names: the Model matches raw keys via the
// Manager and hands the resolved registry id to HandleAction — no key string is
// ever compared here. Todo 9 wires the Router into the Model: editor.OnSubmit →
// Submit, EventMsg(agent_start/agent_end) → SetStreaming/AgentEnd,
// EventMsg(queue_update) → SyncSteering, CommandResultMsg → HandleBashResult.

// actionFollowUp is the registry id for the queue-follow-up chord (alt+enter by
// default). actionDequeue and actionInterrupt live in model.go.
const actionFollowUp = "app.message.followUp"

// bashBusyNotice mirrors interactive-mode.ts:3058 verbatim (the warning shown
// when a second `!` command is submitted while one is still running).
const bashBusyNotice = "A bash command is already running. Press Esc to cancel it first."

// noQueuedNotice / restore notices mirror interactive-mode.ts handleDequeue.
const noQueuedNotice = "No queued messages to restore"

// Commander is the narrow command seam the Router issues RPC through, matching
// the todo-2 Session helpers so tests inject fakes. Every method returns a
// tea.Cmd — the blocking bridge Request runs on the runtime's goroutine, never
// on the Update goroutine.
type Commander interface {
	// Prompt sends a fresh user turn (rpc-types.ts prompt).
	Prompt(message string) tea.Cmd
	// Steer injects a mid-turn steer message into the running turn.
	Steer(message string) tea.Cmd
	// FollowUp queues a follow-up daemon-side behind a just-started turn (used
	// by the agent_end flush for everything after the first fired message).
	FollowUp(message string) tea.Cmd
	// Bash runs a `!` shell command through the daemon executor (rpc-types.ts:53).
	Bash(command string, excludeFromContext bool) tea.Cmd
	// AbortBash cancels the in-flight bash command (rpc-types.ts:54).
	AbortBash() tea.Cmd
	// Request issues an arbitrary RPC command — the generic seam builtin slash
	// actions (/compact, /name, /copy, ...) resolve through.
	Request(cmd bridge.Command) tea.Cmd
}

// Session satisfies Commander; Bash and Request are the todo-4 additions below.
var _ Commander = (*Session)(nil)

// Bash builds the RPC `bash` command for a `!`/`!!` submission. The response
// carries the full BashResult; there is no chunk streaming over the wire, so
// the BashBlock renders `$ cmd` immediately and fills on completion.
func (s *Session) Bash(command string, excludeFromContext bool) tea.Cmd {
	return s.request(slash.BashCommand(command, excludeFromContext))
}

// Request exposes the generic command seam over the adapter's default-timeout
// request path — the Router's builtin RPC actions and the overlay Requester
// (todo 5) both issue through it.
func (s *Session) Request(cmd bridge.Command) tea.Cmd {
	return s.request(cmd)
}

// EditorBuffer is the narrow editor seam the Router mutates: draft text
// save/restore (bash-busy, dequeue), in-editor prompt history, and the
// autocomplete provider hook. *editor.Editor satisfies it.
type EditorBuffer interface {
	GetText() string
	SetText(text string)
	AddToHistory(text string)
	SetAutocompleteProvider(p editor.AutocompleteProvider)
}

var _ EditorBuffer = (*editor.Editor)(nil)

// PromptHistory is the prompt-history PERSISTENCE seam. internal/store exposes
// no prompt-history API today, so this stays a narrow interface rather than an
// invented store schema: todo 9 wires the store-backed implementation (and the
// startup preload into editor.AddToHistory) once the daemon-side history file
// contract is settled. A nil history keeps the in-editor (session-local)
// history only.
type PromptHistory interface {
	// Append records one submitted line (prompt, steer, follow-up, bash, or
	// slash command), newest last.
	Append(text string)
}

// RouteKind classifies what the Router did with a submission or action.
type RouteKind int

const (
	// RouteNone: empty input (or an empty follow-up chord) — nothing happened.
	RouteNone RouteKind = iota
	// RoutePrompt: sent to the agent as a fresh turn (plain text while idle,
	// extension/prompt commands, unknown `/name` fallthrough pre-bootstrap).
	RoutePrompt
	// RouteSteerQueued: streaming plain enter — queued as steering AND delivered
	// to the running turn via the steer RPC.
	RouteSteerQueued
	// RouteFollowUpQueued: streaming follow-up chord — queued locally; fires on
	// agent_end (never earlier).
	RouteFollowUpQueued
	// RouteBash: a `!`/`!!` command started with a live BashBlock.
	RouteBash
	// RouteBashBusy: `!` rejected because one is already running; the submitted
	// text was restored to the editor and Notice carries the classic warning.
	RouteBashBusy
	// RouteOverlay: a builtin resolved to an overlay intent (todo-5 stack opens
	// Overlay, e.g. /model → model selector). Arg carries the command tail.
	RouteOverlay
	// RouteRPC: a builtin resolved to a direct RPC (Cmd is live). Follow/Arg
	// carry the composite post-step (/copy → clipboard, /share → gist, /import
	// → confirm) for todo 9 to run on the CommandResultMsg.
	RouteRPC
	// RouteNative: a builtin resolved to a neo-local action (quit/reload/
	// changelog/jsonl export) that todo 9 executes.
	RouteNative
	// RouteUnknown: `/name` matching nothing — Notice carries the grok-style
	// inline error.
	RouteUnknown
	// RouteDequeued: the dequeue action ran; queued messages (if any) were
	// restored into the editor and Notice carries the status line.
	RouteDequeued
	// RouteAbortBash: the interrupt action was claimed by a running bash
	// command and abort_bash was issued.
	RouteAbortBash
)

// RouteResult is the typed outcome of Submit / HandleAction. Cmd is the RPC
// leaving as a tea.Cmd (nil when the route is purely local); the remaining
// fields carry the intent payload for the routes todo 9 interprets.
type RouteResult struct {
	Kind    RouteKind
	Cmd     tea.Cmd
	Overlay slash.OverlayKind // RouteOverlay target
	Native  slash.NativeKind  // RouteNative target
	Follow  slash.NativeKind  // RouteRPC composite post-step
	Arg     string            // parsed command argument (overlay search, paths)
	Notice  string            // one-line status/warning/inline-error text
}

// Router owns editor-submission routing and the message queue lifecycle.
type Router struct {
	dispatcher *slash.Dispatcher
	queue      *shell.Queue
	commander  Commander
	th         *theme.Theme

	editor  EditorBuffer
	history PromptHistory

	// known is the dynamic command set from get_commands (nil until
	// WireAutocomplete): with it, unknown `/name` surfaces an inline error;
	// without it, classic forwards the line to prompt.
	known map[string]bool

	streaming   bool
	bash        *slash.BashBlock
	bashRunning bool
}

// NewRouter builds the input router over the slash Dispatcher, the shared
// shell queue (the same instance the pending-messages display renders), the
// command seam, and the theme (for BashBlock styling).
func NewRouter(d *slash.Dispatcher, q *shell.Queue, c Commander, th *theme.Theme) *Router {
	return &Router{dispatcher: d, queue: q, commander: c, th: th}
}

// AttachEditor installs the editor seam (draft restore, history, autocomplete).
func (r *Router) AttachEditor(ed EditorBuffer) { r.editor = ed }

// SetHistory installs the prompt-history persistence sink (todo 9 wiring).
func (r *Router) SetHistory(h PromptHistory) { r.history = h }

// SetStreaming records whether a turn is in flight (agent_start / bootstrap
// isStreaming). It selects the prompt-vs-queue path for plain submissions.
func (r *Router) SetStreaming(v bool) { r.streaming = v }

// Streaming reports the recorded streaming state.
func (r *Router) Streaming() bool { return r.streaming }

// IsBashRunning reports whether a `!` command is awaiting its response.
func (r *Router) IsBashRunning() bool { return r.bashRunning }

// BashBlock returns the most recent bash render block (nil before the first
// `!` command). Todo 9 places it: pending area while streaming, chat when idle.
func (r *Router) BashBlock() *slash.BashBlock { return r.bash }

// WireAutocomplete builds the CombinedProvider over the merged command list
// (builtins → prompts → extensions → skills), installs it on the attached
// editor, and records the dynamic names as dispatch knowledge. Call it with
// the get_commands response at bootstrap (and again on reload). fdPath ""
// disables fuzzy @file search, matching the classic fdPath:null handling.
func (r *Router) WireAutocomplete(dynamic []bridge.RPCSlashCommand, basePath, fdPath string) *slash.CombinedProvider {
	merged := slash.MergeCommands(dynamic)
	provider := slash.NewCombinedProvider(slash.AsCommands(merged), basePath, fdPath)
	if r.editor != nil {
		r.editor.SetAutocompleteProvider(provider)
	}
	known := make(map[string]bool, len(dynamic))
	for _, c := range dynamic {
		known[c.Name] = true
	}
	r.known = known
	return provider
}

// Submit routes one submitted editor line, mirroring the classic onSubmit
// ordering: builtins → bash mode → dynamic commands / prompt, with the
// streaming state selecting prompt vs steer-queue for plain text.
func (r *Router) Submit(text string) RouteResult {
	res := r.dispatcher.ClassifyWithKnown(text, r.known)

	switch res.Kind {
	case slash.DispatchIgnore:
		return RouteResult{Kind: RouteNone}

	case slash.DispatchBuiltin:
		r.recordHistory(res.Text)
		return r.routeBuiltin(res.Action)

	case slash.DispatchBash:
		return r.startBash(res)

	case slash.DispatchExtensionCommand:
		// Extension/prompt/skill commands execute immediately via prompt, even
		// while streaming (interactive-mode.ts:3045-3049).
		r.recordHistory(res.Text)
		return RouteResult{Kind: RoutePrompt, Cmd: r.commander.Prompt(res.Text)}

	case slash.DispatchUnknownCommand:
		return RouteResult{Kind: RouteUnknown, Arg: res.UnknownName, Notice: slash.UnknownCommandError(res.UnknownName)}

	default: // slash.DispatchPrompt
		r.recordHistory(res.Text)
		if r.streaming {
			// Plain enter during streaming steers: the local queue entry feeds
			// the pending display; the steer RPC delivers it to the running turn
			// (classic session.prompt(text, {streamingBehavior:"steer"})).
			r.queue.Enqueue(res.Text, shell.QueueSteering)
			return RouteResult{Kind: RouteSteerQueued, Cmd: r.commander.Steer(res.Text)}
		}
		return RouteResult{Kind: RoutePrompt, Cmd: r.commander.Prompt(res.Text)}
	}
}

// routeBuiltin translates a resolved builtin Action into its route. Every
// builtin lands on exactly one of overlay/RPC/native (the acceptance test
// rejects ActionNone stubs).
func (r *Router) routeBuiltin(a slash.Action) RouteResult {
	switch a.Kind {
	case slash.ActionOpenOverlay:
		return RouteResult{Kind: RouteOverlay, Overlay: a.Overlay, Arg: a.Arg}
	case slash.ActionRPC:
		return RouteResult{Kind: RouteRPC, Cmd: r.commander.Request(a.Command), Follow: a.Follow, Arg: a.Arg}
	case slash.ActionNative:
		return RouteResult{Kind: RouteNative, Native: a.Native, Arg: a.Arg}
	default:
		// Unreachable while NewBuiltins keeps every handler concrete; surface it
		// as an inline error rather than dropping the line silently.
		return RouteResult{Kind: RouteUnknown, Notice: slash.UnknownCommandError(strings.TrimPrefix(a.Arg, "/"))}
	}
}

// startBash begins a `!`/`!!` execution: one command at a time (classic
// warning + draft restore otherwise), a live BashBlock, and the bash RPC.
func (r *Router) startBash(res slash.Result) RouteResult {
	if r.bashRunning {
		if r.editor != nil {
			r.editor.SetText(res.Text)
		}
		return RouteResult{Kind: RouteBashBusy, Notice: bashBusyNotice}
	}
	r.recordHistory(res.Text)
	r.bash = slash.NewBashBlock(res.BashCommand, res.BashExcluded, r.th)
	r.bashRunning = true
	return RouteResult{Kind: RouteBash, Cmd: r.commander.Bash(res.BashCommand, res.BashExcluded)}
}

// HandleAction routes a RESOLVED keybinding action name (the Model matches raw
// keys through the Manager first — no key strings here). It reports false for
// actions the Router does not claim, letting the Model's own handlers run.
func (r *Router) HandleAction(action string) (RouteResult, bool) {
	switch action {
	case actionFollowUp:
		return r.followUpAction(), true
	case actionDequeue:
		return r.dequeueAction(), true
	case actionInterrupt:
		// The interrupt chord is claimed only while a bash command runs; the
		// Model's abort path (AbortRequested → session.Abort) owns it otherwise.
		if r.bashRunning {
			return RouteResult{Kind: RouteAbortBash, Cmd: r.commander.AbortBash()}, true
		}
		return RouteResult{}, false
	}
	return RouteResult{}, false
}

// followUpAction queues the current editor draft as a follow-up while
// streaming (local until agent_end); when idle it acts like plain enter
// (interactive-mode.ts:3975-3978).
func (r *Router) followUpAction() RouteResult {
	text := strings.TrimSpace(r.editorText())
	if text == "" {
		return RouteResult{Kind: RouteNone}
	}
	if r.editor != nil {
		r.editor.SetText("")
	}
	if !r.streaming {
		return r.Submit(text)
	}
	r.recordHistory(text)
	r.queue.Enqueue(text, shell.QueueFollowUp)
	return RouteResult{Kind: RouteFollowUpQueued}
}

// dequeueAction drains ALL queued messages back into the editor —
// [...steering, ...followUp] ahead of the current draft, joined with blank
// lines (restoreQueuedMessagesToEditor). Steering already consumed by the
// running turn is daemon-side history and cannot be recalled over RPC; only
// what the queue still holds is restored.
func (r *Router) dequeueAction() RouteResult {
	restored := r.queue.Dequeue()
	if len(restored) == 0 {
		return RouteResult{Kind: RouteDequeued, Notice: noQueuedNotice}
	}
	parts := []string{strings.Join(restored, "\n\n")}
	if current := strings.TrimSpace(r.editorText()); current != "" {
		parts = append(parts, current)
	}
	if r.editor != nil {
		r.editor.SetText(strings.Join(parts, "\n\n"))
	}
	notice := "Restored " + strconv.Itoa(len(restored)) + " queued message"
	if len(restored) > 1 {
		notice += "s"
	}
	notice += " to editor"
	return RouteResult{Kind: RouteDequeued, Notice: notice}
}

// AgentEnd flushes the queue — the ONLY flush point (classic parity). Steering
// consumed during the turn is dropped; the remaining follow-ups fire in FIFO
// order: the first as a prompt starting the next turn, the rest queued behind
// it via follow_up (the flushCompactionQueue delivery pattern). Returns nil
// when nothing was queued.
func (r *Router) AgentEnd() tea.Cmd {
	r.streaming = false
	fired := r.queue.FlushOnAgentEnd()
	if len(fired) == 0 {
		return nil
	}
	cmds := make([]tea.Cmd, 0, len(fired))
	cmds = append(cmds, r.commander.Prompt(fired[0]))
	for _, m := range fired[1:] {
		cmds = append(cmds, r.commander.FollowUp(m))
	}
	return tea.Batch(cmds...)
}

// SyncSteering reconciles the local steering mirror with a queue_update
// event's steering list (the daemon consumes steering mid-turn). Local
// follow-ups are preserved untouched: they exist only here until AgentEnd
// fires them, so the daemon's view never overwrites them.
func (r *Router) SyncSteering(steering []string) {
	_, followUp := r.queue.Messages()
	r.queue.Dequeue() // drain + clear; contents already captured
	for _, m := range steering {
		r.queue.Enqueue(m, shell.QueueSteering)
	}
	for _, m := range followUp {
		r.queue.Enqueue(m, shell.QueueFollowUp)
	}
}

// bashResultData is the BashResult subset the block needs (bash-executor.ts:29
// — output, exitCode undefined when killed, cancelled).
type bashResultData struct {
	Output    string `json:"output"`
	ExitCode  *int   `json:"exitCode"`
	Cancelled bool   `json:"cancelled"`
}

// HandleBashResult consumes the bash command's CommandResultMsg: it appends
// the (single, non-chunked) output to the live block and records the terminal
// status. Returns false for anything that is not the awaited bash response.
func (r *Router) HandleBashResult(msg CommandResultMsg) bool {
	if msg.Command != "bash" || r.bash == nil || !r.bashRunning {
		return false
	}
	r.bashRunning = false

	if msg.Err != nil {
		r.bash.AppendOutput(msg.Err.Error() + "\n")
		r.bash.SetComplete(1, false)
		return true
	}
	if !msg.Response.Success {
		if msg.Response.Error != "" {
			r.bash.AppendOutput(msg.Response.Error + "\n")
		}
		r.bash.SetComplete(1, false)
		return true
	}

	var data bashResultData
	if err := json.Unmarshal(msg.Response.Data, &data); err != nil {
		r.bash.AppendOutput(err.Error() + "\n")
		r.bash.SetComplete(1, false)
		return true
	}
	if data.Output != "" {
		r.bash.AppendOutput(data.Output)
	}
	// exitCode is undefined when the process was killed/cancelled; cancelled
	// wins inside SetComplete, and a missing code on a non-cancelled result is
	// reported as a failure.
	exit := 1
	if data.ExitCode != nil {
		exit = *data.ExitCode
	}
	r.bash.SetComplete(exit, data.Cancelled)
	return true
}

// recordHistory adds one submitted line to the in-editor history and the
// persistence sink (both nil-safe).
func (r *Router) recordHistory(text string) {
	if r.editor != nil {
		r.editor.AddToHistory(text)
	}
	if r.history != nil {
		r.history.Append(text)
	}
}

// editorText reads the current draft (empty without an attached editor).
func (r *Router) editorText() string {
	if r.editor == nil {
		return ""
	}
	return r.editor.GetText()
}
