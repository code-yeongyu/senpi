package slash

import "strings"

// DispatchKind classifies a submitted editor line.
type DispatchKind int

const (
	// DispatchIgnore: empty/whitespace-only input (interactive-mode.ts onSubmit
	// `if (!text) return`).
	DispatchIgnore DispatchKind = iota
	// DispatchBuiltin: a builtin slash command with a resolved Action.
	DispatchBuiltin
	// DispatchBash: `!cmd` (or `!!cmd`) with a non-empty command.
	DispatchBash
	// DispatchExtensionCommand: a `/name` that matches a known dynamic command
	// (extension/prompt/skill) — sent to the agent via prompt.
	DispatchExtensionCommand
	// DispatchUnknownCommand: a `/name` that is neither a builtin nor a known
	// dynamic command — surfaces a grok-style inline error.
	DispatchUnknownCommand
	// DispatchPrompt: plain text (or a `!` with no command) — sent to the agent.
	DispatchPrompt
)

// Result is the classified outcome of a submitted line.
type Result struct {
	Kind         DispatchKind
	Builtin      Handler // valid when Kind == DispatchBuiltin
	Action       Action  // resolved builtin action when Kind == DispatchBuiltin
	BashCommand  string  // parsed command when Kind == DispatchBash
	BashExcluded bool    // true for `!!` (exclude from context)
	UnknownName  string  // command name (no slash) when Kind == DispatchUnknownCommand
	Text         string  // the trimmed input (for prompt paths)
}

// Dispatcher routes submitted editor text, mirroring the classic
// interactive-mode.ts onSubmit ordering: builtin commands → bash mode → dynamic
// commands / prompt. It holds the builtin registry; dynamic command knowledge is
// supplied per-call (from get_commands) via ClassifyWithKnown.
type Dispatcher struct {
	builtins *Builtins
}

// NewDispatcher builds a dispatcher over the builtin registry.
func NewDispatcher(b *Builtins) *Dispatcher { return &Dispatcher{builtins: b} }

// Classify routes text without knowledge of dynamic commands: an unknown `/name`
// is reported as DispatchUnknownCommand only when the caller has no dynamic set.
// Use ClassifyWithKnown to treat known dynamic commands as extension prompts.
func (d *Dispatcher) Classify(text string) Result {
	return d.classify(text, nil)
}

// ClassifyWithKnown routes text, treating any `/name` present in known as a
// dynamic extension command (DispatchExtensionCommand) rather than unknown.
func (d *Dispatcher) ClassifyWithKnown(text string, known map[string]bool) Result {
	return d.classify(text, known)
}

func (d *Dispatcher) classify(text string, known map[string]bool) Result {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return Result{Kind: DispatchIgnore}
	}

	// Builtin slash commands (exact name or "name " prefix).
	if strings.HasPrefix(trimmed, "/") {
		name := commandName(trimmed)
		if h, ok := d.builtins.Lookup(name); ok {
			return Result{Kind: DispatchBuiltin, Builtin: h, Action: h.Handle(trimmed), Text: trimmed}
		}
	}

	// Bash mode: `!cmd` / `!!cmd` (interactive-mode.ts:3053-3068). A bare `!`
	// with no command falls through to prompt.
	if strings.HasPrefix(trimmed, "!") {
		excluded := strings.HasPrefix(trimmed, "!!")
		var command string
		if excluded {
			command = strings.TrimSpace(trimmed[2:])
		} else {
			command = strings.TrimSpace(trimmed[1:])
		}
		if command != "" {
			return Result{Kind: DispatchBash, BashCommand: command, BashExcluded: excluded, Text: trimmed}
		}
		// bare "!" — prompt.
		return Result{Kind: DispatchPrompt, Text: trimmed}
	}

	// Dynamic slash command vs unknown.
	if strings.HasPrefix(trimmed, "/") {
		name := commandName(trimmed)
		if known != nil {
			if known[name] {
				return Result{Kind: DispatchExtensionCommand, Text: trimmed}
			}
			// The caller supplied the merged command set and this /name is not in
			// it — surface the grok-style inline error.
			return Result{Kind: DispatchUnknownCommand, UnknownName: name, Text: trimmed}
		}
		// No dynamic knowledge: classic forwards a non-builtin /name to
		// session.prompt (extension/prompt commands execute there). Route to
		// prompt so the agent decides — parity with interactive-mode.ts.
		return Result{Kind: DispatchPrompt, Text: trimmed}
	}

	return Result{Kind: DispatchPrompt, Text: trimmed}
}

// commandName returns the command name (no leading slash) up to the first space.
func commandName(text string) string {
	body := strings.TrimPrefix(text, "/")
	if i := strings.Index(body, " "); i >= 0 {
		return body[:i]
	}
	return body
}

// UnknownCommandError is the grok-style inline error for an unrecognized slash
// command (failure-path parity in the QA scenario).
func UnknownCommandError(name string) string {
	return "Unknown command: /" + name
}
