package slash

import (
	"context"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
)

// CombinedProvider ports CombinedAutocompleteProvider (autocomplete.ts:273-770).
// It handles slash-command name completion, @file-mention fuzzy search (fd), and
// plain path completion (readdir), and it drives the wave-1 editor by
// implementing editor.AutocompleteProvider + editor.CtxAutocompleteProvider (for
// abortable @file lookups) + the ShouldTriggerFileCompletion gate.
type CombinedProvider struct {
	commands []Command
	basePath string
	fdPath   string
}

// NewCombinedProvider constructs the provider. fdPath "" disables the fuzzy
// @file search (readdir path completion still works), matching the classic
// `fdPath: string | null` handling.
func NewCombinedProvider(commands []Command, basePath, fdPath string) *CombinedProvider {
	return &CombinedProvider{commands: commands, basePath: basePath, fdPath: fdPath}
}

// TriggerCharacters declares the extra symbol-completion trigger characters the
// provider serves. The editor already includes '@'; we return it explicitly so
// the provider is self-describing (the editor de-dupes).
func (p *CombinedProvider) TriggerCharacters() []string { return []string{"@"} }

// GetSuggestions is the synchronous entry point (editor.AutocompleteProvider).
// @file lookups block on fd here; the editor prefers GetSuggestionsCtx when it
// wants cancellation.
func (p *CombinedProvider) GetSuggestions(lines []string, cursorLine, cursorCol int, force bool) (*editor.Suggestions, error) {
	return p.GetSuggestionsCtx(context.Background(), lines, cursorLine, cursorCol, force)
}

// GetSuggestionsCtx is the cancellable entry point (editor.CtxAutocompleteProvider).
// The context is threaded into the fd walk so a superseding keystroke aborts the
// in-flight child (autocomplete.ts options.signal parity).
func (p *CombinedProvider) GetSuggestionsCtx(ctx context.Context, lines []string, cursorLine, cursorCol int, force bool) (*editor.Suggestions, error) {
	currentLine := ""
	if cursorLine >= 0 && cursorLine < len(lines) {
		currentLine = lines[cursorLine]
	}
	before := runeSlice(currentLine, 0, cursorCol)

	// 1. @file mention.
	if atPrefix := p.extractAtPrefix(before); atPrefix != "" {
		raw, _, quoted := parsePathPrefix(atPrefix)
		items := p.fuzzyFileSuggestions(ctx, raw, quoted)
		if len(items) == 0 {
			return nil, nil
		}
		return &editor.Suggestions{Items: items, Prefix: atPrefix}, nil
	}

	// 2. Slash command name / argument completion (not forced/file).
	if !force && strings.HasPrefix(before, "/") {
		spaceIdx := strings.Index(before, " ")
		if spaceIdx == -1 {
			prefix := before[1:]
			items := slashCommandSuggestions(p.commands, prefix)
			if len(items) == 0 {
				return nil, nil
			}
			return &editor.Suggestions{Items: items, Prefix: before}, nil
		}
		// Command with an argument: only "/model <query>" completes arguments
		// (model list). Other commands have no argument completion here.
		commandName := before[1:spaceIdx]
		argText := before[spaceIdx+1:]
		if commandName == "model" {
			items := p.modelArgumentCompletions(argText)
			if len(items) == 0 {
				return nil, nil
			}
			return &editor.Suggestions{Items: items, Prefix: argText}, nil
		}
		// Fall through to path completion for command arguments (e.g. "/export /").
	}

	// 3. Plain path completion (readdir).
	pathMatch, ok := p.extractPathPrefix(before, force)
	if !ok {
		return nil, nil
	}
	items := p.fileSuggestions(pathMatch)
	if len(items) == 0 {
		return nil, nil
	}
	return &editor.Suggestions{Items: items, Prefix: pathMatch}, nil
}

// modelArgumentCompletions is the neo analogue of the /model getArgumentCompletions
// hook (interactive-mode.ts:602-629). Without a live model registry in this
// package it returns nil (no argument completions); the overlay path (task 12)
// owns the model list. The slash-command name completion still surfaces /model.
func (p *CombinedProvider) modelArgumentCompletions(_ string) []editor.Item {
	return nil
}

// ShouldTriggerFileCompletion gates forced (Tab) file completion: it is vetoed
// while typing a slash command with no argument yet (autocomplete.ts:759-769).
func (p *CombinedProvider) ShouldTriggerFileCompletion(lines []string, cursorLine, cursorCol int) bool {
	currentLine := ""
	if cursorLine >= 0 && cursorLine < len(lines) {
		currentLine = lines[cursorLine]
	}
	before := strings.TrimSpace(runeSlice(currentLine, 0, cursorCol))
	if strings.HasPrefix(before, "/") && !strings.Contains(before, " ") {
		return false
	}
	return true
}

// ApplyCompletion inserts the selected item, porting applyCompletion
// (autocomplete.ts:359-444): slash-command names get "/<name> ", @file
// attachments append a trailing space (files) or none (directories) and avoid
// duplicating a closing quote, and plain paths replace the prefix in place.
func (p *CombinedProvider) ApplyCompletion(lines []string, cursorLine, cursorCol int, item editor.Item, prefix string) editor.ApplyResult {
	currentLine := ""
	if cursorLine >= 0 && cursorLine < len(lines) {
		currentLine = lines[cursorLine]
	}
	prefixLen := len([]rune(prefix))
	beforePrefix := runeSlice(currentLine, 0, cursorCol-prefixLen)
	afterCursor := runeSliceFrom(currentLine, cursorCol)

	isQuotedPrefix := strings.HasPrefix(prefix, `"`) || strings.HasPrefix(prefix, `@"`)
	hasLeadingQuoteAfter := strings.HasPrefix(afterCursor, `"`)
	hasTrailingQuoteItem := strings.HasSuffix(item.Value, `"`)
	adjustedAfter := afterCursor
	if isQuotedPrefix && hasTrailingQuoteItem && hasLeadingQuoteAfter {
		adjustedAfter = runeSliceFrom(afterCursor, 1)
	}

	setLine := func(newLine string, col int) editor.ApplyResult {
		out := append([]string(nil), lines...)
		if cursorLine >= 0 && cursorLine < len(out) {
			out[cursorLine] = newLine
		}
		return editor.ApplyResult{Lines: out, CursorLine: cursorLine, CursorCol: col}
	}

	// Slash command name completion.
	isSlashCommand := strings.HasPrefix(prefix, "/") && strings.TrimSpace(beforePrefix) == "" && !strings.Contains(prefix[1:], "/")
	if isSlashCommand {
		newLine := beforePrefix + "/" + item.Value + " " + adjustedAfter
		col := len([]rune(beforePrefix)) + len([]rune(item.Value)) + 2 // "/" + name + " "
		return setLine(newLine, col)
	}

	// @file attachment completion.
	if strings.HasPrefix(prefix, "@") {
		isDir := strings.HasSuffix(item.Label, "/")
		suffix := " "
		if isDir {
			suffix = ""
		}
		newLine := beforePrefix + item.Value + suffix + adjustedAfter
		hasTrailingQuote := strings.HasSuffix(item.Value, `"`)
		offset := len([]rune(item.Value))
		if isDir && hasTrailingQuote {
			offset = len([]rune(item.Value)) - 1
		}
		col := len([]rune(beforePrefix)) + offset + len([]rune(suffix))
		return setLine(newLine, col)
	}

	// Command argument completion ("/cmd <path>") or plain path completion.
	newLine := beforePrefix + item.Value + adjustedAfter
	isDir := strings.HasSuffix(item.Label, "/")
	hasTrailingQuote := strings.HasSuffix(item.Value, `"`)
	offset := len([]rune(item.Value))
	if isDir && hasTrailingQuote {
		offset = len([]rune(item.Value)) - 1
	}
	col := len([]rune(beforePrefix)) + offset
	return setLine(newLine, col)
}
