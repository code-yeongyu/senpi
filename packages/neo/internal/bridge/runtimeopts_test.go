package bridge

import (
	"encoding/json"
	"reflect"
	"testing"
)

// The neo launcher (packages/coding-agent/src/cli/neo/build-argv.ts) turns the
// classic parsed argv into the argv it hands the Go binary. ParseNeoRuntimeArgv
// is the Go inverse: it turns that argv back into the typed NeoRuntimeOptions the
// client sends in the hello handshake, so per-client startup flags survive daemon
// sharing. The two must agree flag-for-flag; these cases are derived directly
// from build-argv.ts.

func TestParseNeoRuntimeArgv_ProviderModelThinkingAuth(t *testing.T) {
	argv := []string{
		"--provider", "anthropic",
		"--model", "claude-fable-5",
		"--models", "a,b,c",
		"--thinking", "xhigh",
		"--api-key", "sk-fake-123",
	}
	opts, rest := ParseNeoRuntimeArgv(argv)
	if len(rest) != 0 {
		t.Fatalf("unexpected residual args: %v", rest)
	}
	if opts.Provider == nil || *opts.Provider != "anthropic" {
		t.Fatalf("provider: %v", derefStr(opts.Provider))
	}
	if opts.Model == nil || *opts.Model != "claude-fable-5" {
		t.Fatalf("model: %v", derefStr(opts.Model))
	}
	if !reflect.DeepEqual(opts.Models, []string{"a", "b", "c"}) {
		t.Fatalf("models: %v", opts.Models)
	}
	if opts.Thinking == nil || *opts.Thinking != "xhigh" {
		t.Fatalf("thinking: %v", derefStr(opts.Thinking))
	}
	if opts.APIKey == nil || *opts.APIKey != "sk-fake-123" {
		t.Fatalf("apiKey: %v", derefStr(opts.APIKey))
	}
}

func TestParseNeoRuntimeArgv_SessionSelection(t *testing.T) {
	argv := []string{
		"--session", "sess.jsonl",
		"--session-id", "id-1",
		"--session-dir", "/tmp/sd",
		"--fork", "entry-9",
		"--name", "my run",
		"--resume",
		"--continue",
		"--no-session",
	}
	opts, rest := ParseNeoRuntimeArgv(argv)
	if len(rest) != 0 {
		t.Fatalf("unexpected residual args: %v", rest)
	}
	if derefStr(opts.Session) != "sess.jsonl" ||
		derefStr(opts.SessionID) != "id-1" ||
		derefStr(opts.SessionDir) != "/tmp/sd" ||
		derefStr(opts.Fork) != "entry-9" ||
		derefStr(opts.Name) != "my run" {
		t.Fatalf("session values wrong: %+v", opts)
	}
	if !derefBool(opts.Resume) || !derefBool(opts.Continue) || !derefBool(opts.NoSession) {
		t.Fatalf("session flags wrong: %+v", opts)
	}
}

func TestParseNeoRuntimeArgv_ApprovalOverride(t *testing.T) {
	yes, _ := ParseNeoRuntimeArgv([]string{"--approve"})
	if yes.ProjectTrustOverride == nil || *yes.ProjectTrustOverride != true {
		t.Fatalf("--approve should set projectTrustOverride=true: %+v", yes)
	}
	no, _ := ParseNeoRuntimeArgv([]string{"--no-approve"})
	if no.ProjectTrustOverride == nil || *no.ProjectTrustOverride != false {
		t.Fatalf("--no-approve should set projectTrustOverride=false: %+v", no)
	}
	none, _ := ParseNeoRuntimeArgv([]string{})
	if none.ProjectTrustOverride != nil {
		t.Fatalf("no approval flag should leave projectTrustOverride nil: %+v", none)
	}
}

func TestParseNeoRuntimeArgv_ToolScoping(t *testing.T) {
	argv := []string{
		"--tools", "bash,read",
		"--exclude-tools", "web",
		"--no-tools",
		"--no-builtin-tools",
	}
	opts, _ := ParseNeoRuntimeArgv(argv)
	if !reflect.DeepEqual(opts.Tools, []string{"bash", "read"}) {
		t.Fatalf("tools: %v", opts.Tools)
	}
	if !reflect.DeepEqual(opts.ExcludeTools, []string{"web"}) {
		t.Fatalf("excludeTools: %v", opts.ExcludeTools)
	}
	if !derefBool(opts.NoTools) || !derefBool(opts.NoBuiltinTools) {
		t.Fatalf("tool flags: %+v", opts)
	}
}

func TestParseNeoRuntimeArgv_ResourceLoadingRepeated(t *testing.T) {
	argv := []string{
		"--extension", "./a.ts",
		"--extension", "./b.ts",
		"--skill", "commit",
		"--skill", "review",
		"--prompt-template", "pt1",
		"--theme", "grok",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
	}
	opts, _ := ParseNeoRuntimeArgv(argv)
	if !reflect.DeepEqual(opts.Extensions, []string{"./a.ts", "./b.ts"}) {
		t.Fatalf("extensions: %v", opts.Extensions)
	}
	if !reflect.DeepEqual(opts.Skills, []string{"commit", "review"}) {
		t.Fatalf("skills: %v", opts.Skills)
	}
	if !reflect.DeepEqual(opts.PromptTemplates, []string{"pt1"}) {
		t.Fatalf("promptTemplates: %v", opts.PromptTemplates)
	}
	if !reflect.DeepEqual(opts.Themes, []string{"grok"}) {
		t.Fatalf("themes: %v", opts.Themes)
	}
	if !derefBool(opts.NoExtensions) || !derefBool(opts.NoSkills) ||
		!derefBool(opts.NoPromptTemplates) || !derefBool(opts.NoThemes) ||
		!derefBool(opts.NoContextFiles) {
		t.Fatalf("resource flags: %+v", opts)
	}
}

func TestParseNeoRuntimeArgv_SystemPromptOverrides(t *testing.T) {
	argv := []string{
		"--system-prompt", "be terse",
		"--append-system-prompt", "one",
		"--append-system-prompt", "two",
	}
	opts, rest := ParseNeoRuntimeArgv(argv)
	if len(rest) != 0 {
		t.Fatalf("unexpected residual args: %v", rest)
	}
	if derefStr(opts.SystemPrompt) != "be terse" {
		t.Fatalf("systemPrompt: %v", derefStr(opts.SystemPrompt))
	}
	if !reflect.DeepEqual(opts.AppendSystemPrompt, []string{"one", "two"}) {
		t.Fatalf("appendSystemPrompt: %v", opts.AppendSystemPrompt)
	}
}

func TestParseNeoRuntimeArgv_InitialInputsAndFileArgs(t *testing.T) {
	// build-argv.ts emits positional messages RAW, then @file args re-prefixed
	// with @. Our parser must recover messages and fileArgs (stripping the @).
	argv := []string{
		"summarize this",
		"@src/main.ts",
		"@./notes.md",
	}
	opts, rest := ParseNeoRuntimeArgv(argv)
	if len(rest) != 0 {
		t.Fatalf("unexpected residual args: %v", rest)
	}
	if !reflect.DeepEqual(opts.Messages, []string{"summarize this"}) {
		t.Fatalf("messages: %v", opts.Messages)
	}
	if !reflect.DeepEqual(opts.FileArgs, []string{"src/main.ts", "./notes.md"}) {
		t.Fatalf("fileArgs: %v", opts.FileArgs)
	}
}

func TestParseNeoRuntimeArgv_UnknownFlagsBecomeExtensionFlags(t *testing.T) {
	// build-argv.ts does not know extension flags, but the classic parser records
	// them as unknownFlags. Our Go parser treats an unrecognized --flag as a
	// boolean-true extension flag, and --flag value as a string extension flag.
	argv := []string{
		"--my-ext-bool",
		"--my-ext-val", "hello",
	}
	opts, _ := ParseNeoRuntimeArgv(argv)
	if opts.UnknownFlags == nil {
		t.Fatalf("expected unknownFlags, got nil")
	}
	if v, ok := opts.UnknownFlags["my-ext-bool"]; !ok || v != true {
		t.Fatalf("my-ext-bool: %v ok=%v", v, ok)
	}
	if v, ok := opts.UnknownFlags["my-ext-val"]; !ok || v != "hello" {
		t.Fatalf("my-ext-val: %v ok=%v", v, ok)
	}
}

// isolatedFlagIsNotARuntimeOption: --isolated is a launcher-local flag (it selects
// the transport, not a runtime input). The runtime-options parser must NOT emit it
// as an unknown flag; a separate selector consumes it.
func TestParseNeoRuntimeArgv_IsolatedFlagIgnored(t *testing.T) {
	opts, _ := ParseNeoRuntimeArgv([]string{"--isolated", "--model", "m"})
	if opts.UnknownFlags != nil {
		if _, ok := opts.UnknownFlags["isolated"]; ok {
			t.Fatalf("--isolated must not become an extension flag: %+v", opts.UnknownFlags)
		}
	}
	if derefStr(opts.Model) != "m" {
		t.Fatalf("model should still parse after --isolated: %+v", opts)
	}
}

// TestNeoRuntimeOptionsOmitsEmpty: the hello payload must omit unset fields so the
// daemon applies classic defaults (an omitted field means "classic default").
func TestNeoRuntimeOptionsJSONOmitsEmpty(t *testing.T) {
	opts, _ := ParseNeoRuntimeArgv([]string{"--model", "m"})
	b, err := json.Marshal(opts)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(b)
	if got != `{"model":"m"}` {
		t.Fatalf("expected only model field, got: %s", got)
	}
}

func derefStr(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func derefBool(p *bool) bool {
	return p != nil && *p
}
