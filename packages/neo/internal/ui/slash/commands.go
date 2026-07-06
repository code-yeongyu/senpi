package slash

import (
	"net/url"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
)

// MergedCommand is an entry in the autocomplete command list: its invocation
// name plus the (already source-tagged) description shown in the popup.
type MergedCommand struct {
	Name        string
	Description string
	// Source is "" for builtins, else "prompt" | "extension" | "skill".
	Source string
}

// MergeCommands assembles the autocomplete command list in the classic order:
// builtins → templates(prompt) → extensions → skills. This mirrors
// interactive-mode.ts createBaseAutocompleteProvider (:664-665) where the
// CombinedAutocompleteProvider is constructed with
// [...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList].
//
// dynamic is the get_commands response (RPCSlashCommand[]). Each command's
// `source` selects its bucket. Extension commands whose name collides with a
// builtin are dropped (interactive-mode.ts:640-648 builtinCommandNames filter).
// Descriptions are prefixed with the [u]/[p]/[t]... source tag.
func MergeCommands(dynamic []bridge.RPCSlashCommand) []MergedCommand {
	b := NewBuiltins()
	out := make([]MergedCommand, 0, len(b.order)+len(dynamic))

	// 1. Builtins, in registry order, untagged.
	for _, name := range b.order {
		h, _ := b.Lookup(name)
		out = append(out, MergedCommand{Name: name, Description: h.Description})
	}

	builtinNames := make(map[string]bool, len(b.order))
	for _, n := range b.order {
		builtinNames[n] = true
	}

	// 2..4. Bucket the dynamic commands by source, preserving input order within
	// each bucket (stable, matches the TS map()/filter() ordering).
	var templates, extensions, skills []MergedCommand
	for _, c := range dynamic {
		mc := MergedCommand{
			Name:        c.Name,
			Description: PrefixDescription(c.Description, c.SourceInfo),
			Source:      c.Source,
		}
		switch c.Source {
		case "prompt":
			templates = append(templates, mc)
		case "extension":
			if builtinNames[c.Name] {
				continue // conflicts with a builtin — skipped in autocomplete
			}
			extensions = append(extensions, mc)
		case "skill":
			skills = append(skills, mc)
		}
	}

	out = append(out, templates...)
	out = append(out, extensions...)
	out = append(out, skills...)
	return out
}

// AsCommands converts merged commands into the autocomplete Command list the
// CombinedProvider filters over.
func AsCommands(merged []MergedCommand) []Command {
	cmds := make([]Command, len(merged))
	for i, m := range merged {
		cmds[i] = Command{Name: m.Name, Description: m.Description}
	}
	return cmds
}

// PrefixDescription prefixes a command description with its source tag
// (interactive-mode.ts prefixAutocompleteDescription:570-576). When the source
// yields no tag (missing sourceInfo), the description is returned unchanged.
func PrefixDescription(description string, info bridge.SourceInfo) string {
	tag := AutocompleteSourceTag(info)
	if tag == "" {
		return description
	}
	if description != "" {
		return "[" + tag + "] " + description
	}
	return "[" + tag + "]"
}

// AutocompleteSourceTag ports getAutocompleteSourceTag (interactive-mode.ts:
// 545-568). The scope prefix is u (user) / p (project) / t (anything else,
// including builtin/local). For auto|local|cli sources it is just the prefix;
// npm: sources append the raw npm source; git sources append git:host/path@ref.
//
// A SourceInfo with an empty Source (no source metadata) yields no tag ("") so
// PrefixDescription leaves the description unchanged, matching the classic
// `if (!sourceInfo) return undefined` guard.
func AutocompleteSourceTag(info bridge.SourceInfo) string {
	if info.Source == "" && info.Scope == "" {
		return ""
	}
	scopePrefix := "t"
	switch info.Scope {
	case "user":
		scopePrefix = "u"
	case "project":
		scopePrefix = "p"
	}

	source := strings.TrimSpace(info.Source)
	if source == "auto" || source == "local" || source == "cli" || source == "" {
		return scopePrefix
	}
	if strings.HasPrefix(source, "npm:") {
		return scopePrefix + ":" + source
	}
	if g := parseGitTag(source); g != "" {
		return scopePrefix + ":" + g
	}
	return scopePrefix
}

// parseGitTag returns the "git:host/path[@ref]" fragment for a git source, or ""
// when the source is not a recognizable git URL. It ports the essential shape of
// parseGitUrl (git.ts:172) for the tag: only the host + path + optional ref are
// needed for the autocomplete label. Sources requiring the full hosted-git-info
// shorthand resolution (bare "github.com/u/r" without a protocol) fall back to
// the scope-only tag, matching the classic behavior for unrecognized sources.
func parseGitTag(source string) string {
	trimmed := strings.TrimSpace(source)
	hasGitPrefix := strings.HasPrefix(trimmed, "git:")
	body := trimmed
	if hasGitPrefix {
		body = strings.TrimSpace(trimmed[len("git:"):])
	}

	// Split an explicit #ref (git.ts splitRef takes the last '#').
	ref := ""
	repo := body
	if i := strings.LastIndex(body, "#"); i >= 0 {
		repo = body[:i]
		ref = body[i+1:]
	}

	host, path := "", ""
	switch {
	case strings.HasPrefix(repo, "http://"), strings.HasPrefix(repo, "https://"),
		strings.HasPrefix(repo, "ssh://"), strings.HasPrefix(repo, "git://"):
		u, err := url.Parse(repo)
		if err != nil || u.Hostname() == "" {
			return ""
		}
		host = u.Hostname()
		path = strings.TrimPrefix(u.Path, "/")
	case hasGitPrefix:
		// git: shorthand accepts host/path (git.ts:150-159).
		slash := strings.Index(repo, "/")
		if slash < 0 {
			return ""
		}
		host = repo[:slash]
		path = repo[slash+1:]
		if !strings.Contains(host, ".") && host != "localhost" {
			return ""
		}
	default:
		return ""
	}

	path = strings.TrimSuffix(path, ".git")
	out := "git:" + host + "/" + path
	if ref != "" {
		out += "@" + ref
	}
	return out
}
