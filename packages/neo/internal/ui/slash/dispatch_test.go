package slash

import "testing"

// TestDispatchClassifiesInput mirrors interactive-mode.ts onSubmit routing:
// builtin slash command → its Action; !cmd/!!cmd → bash; /extname → extension
// prompt; plain text → prompt. (interactive-mode.ts:2913-3103)
func TestDispatchClassifiesInput(t *testing.T) {
	d := NewDispatcher(NewBuiltins())

	cases := []struct {
		name    string
		input   string
		wantK   DispatchKind
		wantSub string // subtype hint (overlay/native/rpc-type or bash command)
	}{
		{"empty is ignored", "   ", DispatchIgnore, ""},
		{"builtin overlay", "/model", DispatchBuiltin, "model"},
		{"builtin with arg", "/compact focus", DispatchBuiltin, "compact"},
		{"quit builtin", "/quit", DispatchBuiltin, "quit"},
		{"bash mode", "!ls -la", DispatchBash, "ls -la"},
		{"bash excluded", "!!echo hi", DispatchBash, "echo hi"},
		{"bash empty falls to prompt", "!", DispatchPrompt, ""},
		{"plain text prompt", "hello world", DispatchPrompt, ""},
		// A non-builtin /name with NO dynamic knowledge forwards to the agent as a
		// prompt (classic session.prompt path executes extension commands). The
		// unknown-error path is exercised via ClassifyWithKnown (see below).
		{"unknown slash without known set is a prompt", "/review", DispatchPrompt, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := d.Classify(tc.input)
			if r.Kind != tc.wantK {
				t.Fatalf("Classify(%q) kind = %v, want %v", tc.input, r.Kind, tc.wantK)
			}
			switch tc.wantK {
			case DispatchBuiltin:
				if r.Builtin.Name != tc.wantSub {
					t.Fatalf("builtin name = %q, want %q", r.Builtin.Name, tc.wantSub)
				}
			case DispatchBash:
				if r.BashCommand != tc.wantSub {
					t.Fatalf("bash command = %q, want %q", r.BashCommand, tc.wantSub)
				}
			case DispatchUnknownCommand:
				if r.UnknownName != tc.wantSub {
					t.Fatalf("unknown name = %q, want %q", r.UnknownName, tc.wantSub)
				}
			}
		})
	}
}

// TestBashExcludedFlag asserts !! sets ExcludeFromContext (interactive-mode.ts:
// 3054 isExcluded).
func TestBashExcludedFlag(t *testing.T) {
	d := NewDispatcher(NewBuiltins())
	normal := d.Classify("!ls")
	if normal.Kind != DispatchBash || normal.BashExcluded {
		t.Fatalf("!ls excluded = %v, want false", normal.BashExcluded)
	}
	excluded := d.Classify("!!ls")
	if excluded.Kind != DispatchBash || !excluded.BashExcluded {
		t.Fatalf("!!ls excluded = %v, want true", excluded.BashExcluded)
	}
}

// TestUnknownCommandIsGrokError asserts an unknown /command yields the
// grok-styled inline error text ("Unknown command: /xyzcmd") — the failure-path
// parity requirement in the QA scenario. A dynamic command that DOES exist in
// the merged set is NOT unknown.
func TestUnknownCommandDetection(t *testing.T) {
	d := NewDispatcher(NewBuiltins())
	// With no known dynamic commands, /review is treated as an extension prompt
	// (classic passes unknown-but-slash to session.prompt). Only names that look
	// like a builtin typo but are not registered surface an inline error when the
	// caller opts in via ClassifyWithKnown.
	known := map[string]bool{"review": true}
	r := d.ClassifyWithKnown("/review", known)
	if r.Kind != DispatchExtensionCommand {
		t.Fatalf("/review with known = %v, want DispatchExtensionCommand", r.Kind)
	}
	unknown := d.ClassifyWithKnown("/xyzcmd", known)
	if unknown.Kind != DispatchUnknownCommand {
		t.Fatalf("/xyzcmd = %v, want DispatchUnknownCommand", unknown.Kind)
	}
	if got := UnknownCommandError("xyzcmd"); got != "Unknown command: /xyzcmd" {
		t.Fatalf("error text = %q", got)
	}
}
