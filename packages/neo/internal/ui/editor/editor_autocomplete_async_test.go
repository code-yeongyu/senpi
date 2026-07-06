package editor

import (
	"context"
	"testing"
)

// Ported from packages/tui/test/editor.test.ts > "Autocomplete", the four cases
// that the first port dropped:
//
//   - "aborts active @ autocomplete when typing continues" (line ~2423): the
//     in-flight async provider request is cancelled when a new keystroke arrives.
//     The tui uses AbortController + options.signal; the Go port models the same
//     contract with context.Context cancellation on the provider request.
//   - "awaits async slash command argument completions" (line ~2765)
//   - "ignores invalid slash command argument completion results" (line ~2790)
//   - "does not show argument completions when command has no argument completer"
//     (line ~2813)
//
// The last three exercise CombinedAutocompleteProvider's slash-command argument
// completion. combinedProvider is the Go analogue used to assert the same
// editor-side behavior (arg-completion apply, invalid-result rejection,
// no-completer fall-through to command-name completion).

// asyncAbortProvider models the tui mock in the abort test: getSuggestions blocks
// (a pending request) until the request's context is cancelled, at which point it
// counts one abort and resolves with no suggestions. It implements
// CtxAutocompleteProvider so the editor passes a cancellable context and cancels
// the in-flight request when a new one is triggered.
type asyncAbortProvider struct {
	aborts  int
	started chan struct{}
}

func (p *asyncAbortProvider) GetSuggestions(lines []string, cursorLine, cursorCol int, force bool) (*Suggestions, error) {
	return nil, nil
}

func (p *asyncAbortProvider) GetSuggestionsCtx(ctx context.Context, lines []string, cursorLine, cursorCol int, force bool) (*Suggestions, error) {
	if p.started != nil {
		select {
		case p.started <- struct{}{}:
		default:
		}
	}
	// Block until the editor cancels this request (a new keystroke arrived) or
	// the deadline fires. In the contract the deadline never wins because the
	// next keystroke cancels first.
	<-ctx.Done()
	p.aborts++
	return nil, nil
}

func (p *asyncAbortProvider) ApplyCompletion(lines []string, cursorLine, cursorCol int, item Item, prefix string) ApplyResult {
	return defaultApply(lines, cursorLine, cursorCol, item, prefix)
}

func TestAC_abortsActiveAtAutocompleteWhenTypingContinues(t *testing.T) {
	e := newTestEditor(t)
	p := &asyncAbortProvider{started: make(chan struct{}, 1)}
	e.SetAutocompleteProvider(p)

	e.HandleInput("@")
	e.HandleInput("m")
	e.HandleInput("a")
	e.HandleInput("i")
	// Fire the pending debounced request: the provider now blocks in-flight,
	// mirroring the tui suite's `await setTimeout(250)` reaching the 500ms
	// getSuggestions promise.
	e.AdvanceDebounce()
	e.WaitForAutocompleteInFlight()

	// A further keystroke must abort the in-flight request exactly once.
	e.HandleInput("n")
	e.WaitForAutocompleteRequestsSettled()

	if p.aborts != 1 {
		t.Fatalf("aborts = %d, want 1", p.aborts)
	}
}

// combinedProvider is the Go analogue of tui CombinedAutocompleteProvider for the
// slash-command argument-completion contract. Each command may carry an argument
// completer (sync or async). getSuggestions reproduces the tui branch order:
// slash command-name completion when there is no space, else argument completion
// via the matched command's completer (rejecting non-array/empty results).
type combinedCommand struct {
	name string
	// argCompleter returns argument suggestions, or (nil, false) when the result
	// is invalid (the tui's non-array case), or (nil, true) for a valid-but-empty
	// result. A nil argCompleter means the command has no argument completer.
	argCompleter func(argPrefix string) (items []Item, valid bool)
}

type combinedProvider struct {
	commands []combinedCommand
}

func (p *combinedProvider) command(name string) (combinedCommand, bool) {
	for _, c := range p.commands {
		if c.name == name {
			return c, true
		}
	}
	return combinedCommand{}, false
}

func (p *combinedProvider) GetSuggestions(lines []string, cursorLine, cursorCol int, force bool) (*Suggestions, error) {
	before := ""
	if cursorLine < len(lines) {
		before = runeSlice(lines[cursorLine], 0, cursorCol)
	}
	if force || len(before) == 0 || before[0] != '/' {
		return nil, nil
	}
	spaceIdx := indexByte(before, ' ')
	if spaceIdx < 0 {
		// Command-name completion.
		prefix := before[1:]
		var items []Item
		for _, c := range p.commands {
			if hasPrefix(c.name, prefix) {
				items = append(items, Item{Value: c.name, Label: c.name})
			}
		}
		if len(items) == 0 {
			return nil, nil
		}
		return &Suggestions{Items: items, Prefix: before}, nil
	}
	// Argument completion.
	name := before[1:spaceIdx]
	argText := before[spaceIdx+1:]
	cmd, ok := p.command(name)
	if !ok || cmd.argCompleter == nil {
		return nil, nil
	}
	items, valid := cmd.argCompleter(argText)
	if !valid || len(items) == 0 {
		return nil, nil
	}
	return &Suggestions{Items: items, Prefix: argText}, nil
}

func (p *combinedProvider) ApplyCompletion(lines []string, cursorLine, cursorCol int, item Item, prefix string) ApplyResult {
	// Slash command-name completion: "/<name> " (mirrors tui isSlashCommand path).
	before := ""
	if cursorLine < len(lines) {
		before = runeSlice(lines[cursorLine], 0, cursorCol-runeLen(prefix))
	}
	if len(prefix) > 0 && prefix[0] == '/' && trimSpace(before) == "" && !contains2(prefix[1:], "/") {
		line := lines[cursorLine]
		after := runeSlice(line, cursorCol, runeLen(line))
		newLines := append([]string(nil), lines...)
		newLines[cursorLine] = before + "/" + item.Value + " " + after
		return ApplyResult{
			Lines:      newLines,
			CursorLine: cursorLine,
			CursorCol:  runeLen(before) + runeLen(item.Value) + 2,
		}
	}
	return defaultApply(lines, cursorLine, cursorCol, item, prefix)
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

func contains2(s, sub string) bool {
	return indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	if sub == "" {
		return 0
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestAC_awaitsAsyncSlashCommandArgumentCompletions(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&combinedProvider{commands: []combinedCommand{
		{name: "load-skills", argCompleter: func(prefix string) ([]Item, bool) {
			if hasPrefix(prefix, "s") {
				return []Item{{Value: "skill-a", Label: "skill-a"}}, true
			}
			return nil, true
		}},
	}})
	e.SetText("/load-skills ")

	e.HandleInput("s")
	e.FlushAutocomplete()
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show async arg completion menu")
	}

	e.HandleInput("\t")
	assertText(t, e, "/load-skills skill-a")
	if e.IsShowingAutocomplete() {
		t.Fatal("menu should close after applying arg completion")
	}
}

func TestAC_ignoresInvalidSlashCommandArgumentCompletionResults(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&combinedProvider{commands: []combinedCommand{
		{name: "load-skills", argCompleter: func(prefix string) ([]Item, bool) {
			// Analogue of tui's "not-an-array" invalid result.
			return nil, false
		}},
	}})
	e.SetText("/load-skills ")

	e.HandleInput("s")
	e.FlushAutocomplete()
	if e.IsShowingAutocomplete() {
		t.Fatal("invalid arg completion result must not show a menu")
	}
	assertText(t, e, "/load-skills s")
}

func TestAC_doesNotShowArgumentCompletionsWhenNoArgumentCompleter(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&combinedProvider{commands: []combinedCommand{
		{name: "help"},
		{name: "model", argCompleter: func(prefix string) ([]Item, bool) {
			return []Item{{Value: "claude-opus", Label: "claude-opus"}}, true
		}},
	}})

	e.HandleInput("/")
	e.HandleInput("h")
	e.HandleInput("e")
	e.FlushAutocomplete()
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show command-name completion for /he")
	}

	e.HandleInput("\t")
	assertText(t, e, "/help ")
	if e.IsShowingAutocomplete() {
		t.Fatal("menu should close after applying command-name completion")
	}
}
