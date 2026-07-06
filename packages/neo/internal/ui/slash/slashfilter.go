package slash

import (
	"sort"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
)

// Command is one slash command available to autocomplete (a builtin, template,
// extension, or skill). ArgumentHint mirrors SlashCommand.argumentHint; when
// set, the popup description shows "<hint> — <desc>". Mirrors the tui
// SlashCommand shape (autocomplete.ts:227-234).
type Command struct {
	Name         string
	Description  string
	ArgumentHint string
}

type rankedSlash struct {
	name  string
	label string
	desc  string
	index int
}

// slashCommandSuggestions ports getSlashCommandSuggestions
// (slash-command-autocomplete.ts): fuzzy-filter the commands by the typed prefix
// (after the leading '/'), then apply the exact/prefix/length tie-break sort so
// exact matches lead, then longer prefix matches, then fuzzy order.
func slashCommandSuggestions(commands []Command, prefix string) []editor.Item {
	items := make([]rankedSlash, len(commands))
	for i, c := range commands {
		desc := c.Description
		if c.ArgumentHint != "" {
			if desc != "" {
				desc = c.ArgumentHint + " — " + desc
			} else {
				desc = c.ArgumentHint
			}
		}
		items[i] = rankedSlash{name: c.Name, label: c.Name, desc: desc}
	}

	filtered := ui.FuzzyFilter(items, prefix, func(it rankedSlash) string { return it.name })
	for i := range filtered {
		filtered[i].index = i
	}

	sort.SliceStable(filtered, func(i, j int) bool {
		return lessSlashSuggestion(prefix, filtered[i], filtered[j])
	})

	out := make([]editor.Item, len(filtered))
	for i, r := range filtered {
		out[i] = editor.Item{Value: r.name, Label: r.label, Description: r.desc}
	}
	return out
}

// lessSlashSuggestion reports whether l should sort before r, porting
// compareSlashCommandSuggestion (slash-command-autocomplete.ts:14-27).
func lessSlashSuggestion(prefix string, l, r rankedSlash) bool {
	lExact := l.name == prefix
	rExact := r.name == prefix
	if lExact != rExact {
		return lExact
	}
	lPrefix := strings.HasPrefix(l.name, prefix)
	rPrefix := strings.HasPrefix(r.name, prefix)
	if lPrefix != rPrefix {
		return lPrefix
	}
	if lPrefix && rPrefix && len(l.name) != len(r.name) {
		// Longer prefix match wins (right.value.length - left.value.length < 0).
		return len(l.name) > len(r.name)
	}
	return l.index < r.index
}
