package editor

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
)

// Ported from packages/tui/test/editor.test.ts > "Autocomplete".
//
// TS uses async getSuggestions + setTimeout debounce. The Go port models the
// same contract synchronously: FlushAutocomplete() drains any pending immediate
// request; AdvanceDebounce() fires the debounce timer deterministically (no wall
// clock), replacing the tui suite's `await setTimeout(50)`.

// stubProvider is the Go analogue of the tui mock AutocompleteProvider.
type stubProvider struct {
	triggers []string
	suggest  func(lines []string, cursorLine, cursorCol int, force bool) (*Suggestions, error)
	apply    func(lines []string, cursorLine, cursorCol int, item Item, prefix string) ApplyResult
}

func (p *stubProvider) TriggerCharacters() []string { return p.triggers }
func (p *stubProvider) GetSuggestions(lines []string, cursorLine, cursorCol int, force bool) (*Suggestions, error) {
	return p.suggest(lines, cursorLine, cursorCol, force)
}
func (p *stubProvider) ApplyCompletion(lines []string, cursorLine, cursorCol int, item Item, prefix string) ApplyResult {
	if p.apply != nil {
		return p.apply(lines, cursorLine, cursorCol, item, prefix)
	}
	return defaultApply(lines, cursorLine, cursorCol, item, prefix)
}

// defaultApply mirrors the tui test's applyCompletion: replace prefix with value.
func defaultApply(lines []string, cursorLine, cursorCol int, item Item, prefix string) ApplyResult {
	line := ""
	if cursorLine < len(lines) {
		line = lines[cursorLine]
	}
	before := runeSlice(line, 0, cursorCol-runeLen(prefix))
	after := runeSlice(line, cursorCol, runeLen(line))
	newLines := append([]string(nil), lines...)
	newLines[cursorLine] = before + item.Value + after
	return ApplyResult{
		Lines:      newLines,
		CursorLine: cursorLine,
		CursorCol:  cursorCol - runeLen(prefix) + runeLen(item.Value),
	}
}

func renderJoined(e *Editor, width int) string {
	var lines []string
	for _, l := range e.Render(width) {
		lines = append(lines, textwidth.StripANSI(l))
	}
	return strings.Join(lines, "\n")
}

func TestAC_autoAppliesSingleForceFileSuggestionWithoutMenu(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			if !force {
				return nil, nil
			}
			prefix := runeSlice(lines[0], 0, cc)
			if prefix == "Work" {
				return &Suggestions{Items: []Item{{Value: "Workspace/", Label: "Workspace/"}}, Prefix: "Work"}, nil
			}
			return nil, nil
		},
	})
	typeStr(e, "Work")
	assertText(t, e, "Work")
	e.HandleInput("\t")
	e.FlushAutocomplete()
	assertText(t, e, "Workspace/")
	if e.IsShowingAutocomplete() {
		t.Fatal("should not show menu")
	}
	e.HandleInput(undoKey)
	assertText(t, e, "Work")
}

func TestAC_showsMenuWhenForceFileHasMultipleSuggestions(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			if !force {
				return nil, nil
			}
			prefix := runeSlice(lines[0], 0, cc)
			if prefix == "src" {
				return &Suggestions{Items: []Item{
					{Value: "src/", Label: "src/"},
					{Value: "src.txt", Label: "src.txt"},
				}, Prefix: "src"}, nil
			}
			return nil, nil
		},
	})
	typeStr(e, "src")
	e.HandleInput("\t")
	e.FlushAutocomplete()
	assertText(t, e, "src")
	if !e.IsShowingAutocomplete() {
		t.Fatal("menu should be showing")
	}
	e.HandleInput("\t")
	assertText(t, e, "src/")
	if e.IsShowingAutocomplete() {
		t.Fatal("menu should close after accept")
	}
}

func TestAC_keepsSuggestionsOpenWhenTypingInForceMode(t *testing.T) {
	e := newTestEditor(t)
	all := []Item{
		{Value: "readme.md", Label: "readme.md"},
		{Value: "package.json", Label: "package.json"},
		{Value: "src/", Label: "src/"},
		{Value: "dist/", Label: "dist/"},
	}
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			prefix := runeSlice(lines[0], 0, cc)
			match := force || strings.Contains(prefix, "/") || strings.HasPrefix(prefix, ".")
			if !match {
				return nil, nil
			}
			var filtered []Item
			for _, f := range all {
				if strings.HasPrefix(strings.ToLower(f.Value), strings.ToLower(prefix)) {
					filtered = append(filtered, f)
				}
			}
			if len(filtered) > 0 {
				return &Suggestions{Items: filtered, Prefix: prefix}, nil
			}
			return nil, nil
		},
	})
	e.HandleInput("\t")
	e.FlushAutocomplete()
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show all files in force mode")
	}
	e.HandleInput("r")
	e.FlushAutocomplete()
	assertText(t, e, "r")
	if !e.IsShowingAutocomplete() {
		t.Fatal("force mode should keep suggestions open")
	}
	e.HandleInput("e")
	e.FlushAutocomplete()
	assertText(t, e, "re")
	if !e.IsShowingAutocomplete() {
		t.Fatal("should still show readme.md")
	}
	e.HandleInput("\t")
	assertText(t, e, "readme.md")
	if e.IsShowingAutocomplete() {
		t.Fatal("should close after accept")
	}
}

func TestAC_debouncesAtAutocompleteWhileTyping(t *testing.T) {
	e := newTestEditor(t)
	calls := 0
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			calls++
			text := runeSlice(lines[0], 0, cc)
			return &Suggestions{Items: []Item{{Value: "@main.ts", Label: "main.ts"}}, Prefix: text}, nil
		},
	})
	e.HandleInput("@")
	e.HandleInput("m")
	e.HandleInput("a")
	e.HandleInput("i")
	if calls != 0 {
		t.Fatalf("calls before debounce = %d, want 0", calls)
	}
	if e.IsShowingAutocomplete() {
		t.Fatal("should not show before debounce")
	}
	e.AdvanceDebounce()
	e.FlushAutocomplete()
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show after debounce")
	}
}

func TestAC_reQueriesPickerWhenCursorMovesBackIntoCommandName(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			before := runeSlice(lines[0], 0, cc)
			if !strings.HasPrefix(before, "/") {
				return nil, nil
			}
			if strings.Contains(before, " ") {
				return &Suggestions{Items: []Item{
					{Value: "repo", Label: "repo"},
					{Value: "message", Label: "message"},
					{Value: "help", Label: "help"},
				}, Prefix: before[strings.Index(before, " ")+1:]}, nil
			}
			return &Suggestions{Items: []Item{{Value: "cmd", Label: "cmd"}}, Prefix: before}, nil
		},
	})
	for _, ch := range "/cmd " {
		e.HandleInput(string(ch))
		e.FlushAutocomplete()
	}
	assertText(t, e, "/cmd ")
	if !e.IsShowingAutocomplete() {
		t.Fatal("argument menu should be visible")
	}
	atArg := renderJoined(e, 80)
	if !strings.Contains(atArg, "repo") {
		t.Fatalf("argument menu should show repo: %q", atArg)
	}
	e.HandleInput("\x1b[D")
	e.FlushAutocomplete()
	after := renderJoined(e, 80)
	if strings.Contains(after, "repo") || strings.Contains(after, "message") {
		t.Fatalf("stale argument menu must not survive cursor move: %q", after)
	}
}

func TestAC_debouncesHashAutocompleteWhileTyping(t *testing.T) {
	e := newTestEditor(t)
	calls := 0
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			calls++
			text := runeSlice(lines[0], 0, cc)
			return &Suggestions{Items: []Item{{Value: "#2983", Label: "#2983"}}, Prefix: text}, nil
		},
	})
	e.HandleInput("#")
	e.HandleInput("2")
	e.HandleInput("9")
	e.HandleInput("8")
	if calls != 0 {
		t.Fatalf("calls = %d, want 0 before debounce", calls)
	}
	e.AdvanceDebounce()
	e.FlushAutocomplete()
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show after debounce")
	}
}

func TestAC_debouncesCustomTriggerCharactersWhileTyping(t *testing.T) {
	e := newTestEditor(t)
	calls := 0
	e.SetAutocompleteProvider(&stubProvider{
		triggers: []string{"$"},
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			calls++
			prefix := runeSlice(lines[0], 0, cc)
			return &Suggestions{Items: []Item{{Value: "$skill-name", Label: "skill-name"}}, Prefix: prefix}, nil
		},
	})
	e.HandleInput("$")
	e.HandleInput("s")
	e.HandleInput("k")
	if calls != 0 {
		t.Fatalf("calls = %d, want 0", calls)
	}
	e.AdvanceDebounce()
	e.FlushAutocomplete()
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show")
	}
}

func TestAC_resetsCustomTriggerCharactersWhenProviderChanges(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&stubProvider{
		triggers: []string{"$"},
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			return &Suggestions{Items: []Item{{Value: "$skill-name", Label: "skill-name"}}, Prefix: "$"}, nil
		},
	})
	calls := 0
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			calls++
			return &Suggestions{Items: []Item{{Value: "$skill-name", Label: "skill-name"}}, Prefix: "$"}, nil
		},
	})
	e.HandleInput("$")
	e.HandleInput("s")
	e.AdvanceDebounce()
	e.FlushAutocomplete()
	if calls != 0 {
		t.Fatalf("calls = %d, want 0", calls)
	}
	if e.IsShowingAutocomplete() {
		t.Fatal("should not show")
	}
}

func TestAC_hidesAutocompleteWhenBackspacingSlashCommandToEmpty(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			prefix := runeSlice(lines[0], 0, cc)
			if strings.HasPrefix(prefix, "/") {
				cmds := []Item{
					{Value: "/model", Label: "model"},
					{Value: "/help", Label: "help"},
				}
				query := prefix
				var filtered []Item
				for _, c := range cmds {
					if strings.HasPrefix(c.Value, query) {
						filtered = append(filtered, c)
					}
				}
				if len(filtered) > 0 {
					return &Suggestions{Items: filtered, Prefix: prefix}, nil
				}
			}
			return nil, nil
		},
	})
	e.HandleInput("/")
	e.FlushAutocomplete()
	assertText(t, e, "/")
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show slash suggestions")
	}
	e.HandleInput("\x7f")
	e.FlushAutocomplete()
	assertText(t, e, "")
	if e.IsShowingAutocomplete() {
		t.Fatal("should hide autocomplete")
	}
}

func argtestProvider() *stubProvider {
	return &stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			before := runeSlice(lines[0], 0, cc)
			arg := matchArgtest(before)
			if arg == "" {
				return nil, nil
			}
			all := []Item{{Value: "one", Label: "one"}, {Value: "two", Label: "two"}, {Value: "three", Label: "three"}}
			var filtered []Item
			for _, a := range all {
				if strings.HasPrefix(a.Value, arg) {
					filtered = append(filtered, a)
				}
			}
			if len(filtered) > 0 {
				return &Suggestions{Items: filtered, Prefix: arg}, nil
			}
			return nil, nil
		},
	}
}

func TestAC_appliesExactTypedSlashArgumentValueOnEnter(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(argtestProvider())
	typeStr(e, "/argtest two")
	assertText(t, e, "/argtest two")
	e.FlushAutocomplete()
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show")
	}
	e.HandleInput("\r")
	assertText(t, e, "/argtest two")
}

func TestAC_selectsFirstPrefixMatchOnEnterWhenNotExact(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			before := runeSlice(lines[0], 0, cc)
			arg := matchArgtest(before)
			if arg == "" {
				return nil, nil
			}
			all := []Item{{Value: "two", Label: "two"}, {Value: "three", Label: "three"}, {Value: "twelve", Label: "twelve"}}
			var filtered []Item
			for _, a := range all {
				if strings.HasPrefix(a.Value, arg) {
					filtered = append(filtered, a)
				}
			}
			if len(filtered) > 0 {
				return &Suggestions{Items: filtered, Prefix: arg}, nil
			}
			return nil, nil
		},
	})
	typeStr(e, "/argtest t")
	e.FlushAutocomplete()
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show")
	}
	e.HandleInput("\r")
	assertText(t, e, "/argtest two")
}

func unfilteredArgtestProvider() *stubProvider {
	return &stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			before := runeSlice(lines[0], 0, cc)
			arg := matchArgtest(before)
			if arg == "" {
				return nil, nil
			}
			all := []Item{{Value: "one", Label: "one"}, {Value: "two", Label: "two"}, {Value: "three", Label: "three"}}
			return &Suggestions{Items: all, Prefix: arg}, nil
		},
	}
}

func TestAC_highlightsUniquePrefixMatchAsUserTypes(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(unfilteredArgtestProvider())
	typeStr(e, "/argtest tw")
	assertText(t, e, "/argtest tw")
	e.FlushAutocomplete()
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show")
	}
	e.HandleInput("\r")
	assertText(t, e, "/argtest two")
}

func TestAC_selectsFirstPrefixMatchWhenMultipleItemsMatch(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(unfilteredArgtestProvider())
	typeStr(e, "/argtest t")
	e.FlushAutocomplete()
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show")
	}
	e.HandleInput("\r")
	assertText(t, e, "/argtest two")
}

func TestAC_worksForBuiltinStyleCommandArgumentCompletion(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			before := runeSlice(lines[0], 0, cc)
			arg := matchModel(before)
			if arg == "" {
				return nil, nil
			}
			all := []Item{
				{Value: "gpt-4o", Label: "gpt-4o"},
				{Value: "gpt-4o-mini", Label: "gpt-4o-mini"},
				{Value: "claude-sonnet", Label: "claude-sonnet"},
			}
			var filtered []Item
			for _, m := range all {
				if strings.HasPrefix(m.Value, arg) {
					filtered = append(filtered, m)
				}
			}
			if len(filtered) > 0 {
				return &Suggestions{Items: filtered, Prefix: arg}, nil
			}
			return nil, nil
		},
	})
	typeStr(e, "/model gpt-4o-mini")
	assertText(t, e, "/model gpt-4o-mini")
	e.FlushAutocomplete()
	if !e.IsShowingAutocomplete() {
		t.Fatal("should show")
	}
	e.HandleInput("\r")
	assertText(t, e, "/model gpt-4o-mini")
}
