package slash

import (
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
)

// TestMergeOrderMatchesClassic pins the autocomplete merge order to the classic
// TUI: builtins → templates → extensions → skills (interactive-mode.ts:664-665
// CombinedAutocompleteProvider([...slashCommands, ...templateCommands,
// ...extensionCommands, ...skillCommandList])). get_commands returns the dynamic
// commands (prompt/extension/skill sources); MergeCommands classifies them into
// the three trailing buckets and appends after the builtins in that exact order.
func TestMergeOrderMatchesClassic(t *testing.T) {
	dynamic := []bridge.RPCSlashCommand{
		// intentionally out of order in the input to prove MergeCommands sorts by
		// source bucket, not by input order.
		{Name: "skill:refactor", Source: "skill", SourceInfo: bridge.SourceInfo{Scope: "user", Source: "auto"}},
		{Name: "review", Source: "extension", SourceInfo: bridge.SourceInfo{Scope: "project", Source: "npm:@acme/review"}},
		{Name: "plan", Source: "prompt", SourceInfo: bridge.SourceInfo{Scope: "user", Source: "local"}},
	}
	merged := MergeCommands(dynamic)

	// The first 22 entries must be the builtins in registry order.
	builtins := BuiltinNames()
	if len(merged) < len(builtins) {
		t.Fatalf("merged has %d entries, fewer than %d builtins", len(merged), len(builtins))
	}
	for i, name := range builtins {
		if merged[i].Name != name {
			t.Fatalf("merged[%d] = %q, want builtin %q", i, merged[i].Name, name)
		}
	}

	// After the builtins: templates (prompt), then extensions, then skills.
	tail := merged[len(builtins):]
	wantTail := []string{"plan", "review", "skill:refactor"}
	if len(tail) != len(wantTail) {
		t.Fatalf("tail len = %d, want %d", len(tail), len(wantTail))
	}
	for i, name := range wantTail {
		if tail[i].Name != name {
			t.Fatalf("tail[%d] = %q, want %q", i, tail[i].Name, name)
		}
	}
}

// TestExtensionNameConflictSkipped mirrors createBaseAutocompleteProvider: a
// dynamic command whose name collides with a builtin is dropped from the merged
// autocomplete list (interactive-mode.ts:640-648 filter builtinCommandNames).
func TestExtensionNameConflictSkipped(t *testing.T) {
	dynamic := []bridge.RPCSlashCommand{
		{Name: "model", Source: "extension", SourceInfo: bridge.SourceInfo{Scope: "user", Source: "auto"}},
		{Name: "customcmd", Source: "extension", SourceInfo: bridge.SourceInfo{Scope: "user", Source: "auto"}},
	}
	merged := MergeCommands(dynamic)
	// "model" appears exactly once (the builtin), the extension copy is skipped.
	count := 0
	for _, c := range merged {
		if c.Name == "model" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("'model' appears %d times, want 1 (extension conflict skipped)", count)
	}
	// "customcmd" survives.
	found := false
	for _, c := range merged {
		if c.Name == "customcmd" {
			found = true
		}
	}
	if !found {
		t.Fatal("non-conflicting extension command dropped")
	}
}

// TestSourceTagSemantics ports getAutocompleteSourceTag (interactive-mode.ts:
// 545-568): scope prefix u/p/t; auto|local|cli → just prefix; npm: →
// prefix:npm-source; git → prefix:git:host/path@ref.
func TestSourceTagSemantics(t *testing.T) {
	cases := []struct {
		name   string
		info   bridge.SourceInfo
		expect string
	}{
		{"user auto", bridge.SourceInfo{Scope: "user", Source: "auto"}, "u"},
		{"project local", bridge.SourceInfo{Scope: "project", Source: "local"}, "p"},
		{"builtin cli", bridge.SourceInfo{Scope: "builtin", Source: "cli"}, "t"},
		{"user npm", bridge.SourceInfo{Scope: "user", Source: "npm:@acme/pkg"}, "u:npm:@acme/pkg"},
		{"project npm", bridge.SourceInfo{Scope: "project", Source: "npm:foo"}, "p:npm:foo"},
		{"user git https", bridge.SourceInfo{Scope: "user", Source: "https://github.com/acme/repo"}, "u:git:github.com/acme/repo"},
		{"user git ref", bridge.SourceInfo{Scope: "user", Source: "git:github.com/acme/repo#v1"}, "u:git:github.com/acme/repo@v1"},
		{"unknown scope falls to t", bridge.SourceInfo{Scope: "", Source: "auto"}, "t"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := AutocompleteSourceTag(tc.info)
			if got != tc.expect {
				t.Fatalf("tag = %q, want %q", got, tc.expect)
			}
		})
	}
}

// TestSourceTagNilReturnsEmpty asserts a missing sourceInfo yields no tag
// (getAutocompleteSourceTag returns undefined; PrefixDescription leaves the
// description unchanged).
func TestPrefixDescription(t *testing.T) {
	// npm source → tag prefixed.
	info := bridge.SourceInfo{Scope: "user", Source: "npm:foo"}
	got := PrefixDescription("Do a thing", info)
	if got != "[u:npm:foo] Do a thing" {
		t.Fatalf("prefixed = %q", got)
	}
	// empty description with a tag → just the tag.
	got = PrefixDescription("", info)
	if got != "[u:npm:foo]" {
		t.Fatalf("prefixed empty = %q", got)
	}
	// auto source, no description → just the scope tag.
	got = PrefixDescription("", bridge.SourceInfo{Scope: "user", Source: "auto"})
	if got != "[u]" {
		t.Fatalf("auto empty = %q", got)
	}
}
