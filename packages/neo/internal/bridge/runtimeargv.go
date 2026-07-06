package bridge

import (
	"fmt"
	"sort"
	"strings"
)

// NeoRuntimeOptionsToRpcArgv renders a NeoRuntimeOptions into the classic
// `--mode rpc` runtime-construction argv, mirroring neoRuntimeOptionsToRpcArgv in
// packages/coding-agent/src/modes/rpc/neo-runtime-options-argv.ts. The returned
// argv is what an isolated StdioTransport child (and, on the daemon side, each
// worker) consumes. Initial inputs (Messages / FileArgs) are intentionally NOT
// emitted — an rpc worker does not take them as an initial prompt; they are
// delivered separately as a `prompt` command.
//
// The emission ORDER matches the TS exactly so the two stay behaviorally
// identical (and so a golden comparison is possible).
func NeoRuntimeOptionsToRpcArgv(o NeoRuntimeOptions) []string {
	var argv []string

	argv = pushValue(argv, "--provider", o.Provider)
	argv = pushValue(argv, "--model", o.Model)
	argv = pushCSV(argv, "--models", o.Models)
	argv = pushValue(argv, "--thinking", o.Thinking)
	argv = pushValue(argv, "--api-key", o.APIKey)

	argv = pushValue(argv, "--session", o.Session)
	argv = pushValue(argv, "--session-id", o.SessionID)
	argv = pushValue(argv, "--session-dir", o.SessionDir)
	argv = pushValue(argv, "--fork", o.Fork)
	argv = pushValue(argv, "--name", o.Name)
	argv = pushBool(argv, "--resume", o.Resume)
	argv = pushBool(argv, "--continue", o.Continue)
	argv = pushBool(argv, "--no-session", o.NoSession)

	if o.ProjectTrustOverride != nil {
		if *o.ProjectTrustOverride {
			argv = append(argv, "--approve")
		} else {
			argv = append(argv, "--no-approve")
		}
	}

	argv = pushCSV(argv, "--tools", o.Tools)
	argv = pushCSV(argv, "--exclude-tools", o.ExcludeTools)
	argv = pushBool(argv, "--no-tools", o.NoTools)
	argv = pushBool(argv, "--no-builtin-tools", o.NoBuiltinTools)

	argv = pushRepeated(argv, "--extension", o.Extensions)
	argv = pushRepeated(argv, "--skill", o.Skills)
	argv = pushRepeated(argv, "--prompt-template", o.PromptTemplates)
	argv = pushRepeated(argv, "--theme", o.Themes)
	argv = pushBool(argv, "--no-extensions", o.NoExtensions)
	argv = pushBool(argv, "--no-skills", o.NoSkills)
	argv = pushBool(argv, "--no-prompt-templates", o.NoPromptTemplates)
	argv = pushBool(argv, "--no-themes", o.NoThemes)
	argv = pushBool(argv, "--no-context-files", o.NoContextFiles)

	// Extension (unknown) flags: `--<name>` for boolean-true, `--<name> <value>`
	// otherwise. Sorted for deterministic output (map iteration order is random in
	// Go); the daemon consumes them order-independently.
	if len(o.UnknownFlags) > 0 {
		names := make([]string, 0, len(o.UnknownFlags))
		for name := range o.UnknownFlags {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			value := o.UnknownFlags[name]
			switch v := value.(type) {
			case bool:
				if v {
					argv = append(argv, "--"+name)
				}
			default:
				argv = append(argv, "--"+name, fmt.Sprintf("%v", v))
			}
		}
	}

	return argv
}

func pushValue(argv []string, flag string, value *string) []string {
	if value != nil {
		return append(argv, flag, *value)
	}
	return argv
}

func pushBool(argv []string, flag string, value *bool) []string {
	if value != nil && *value {
		return append(argv, flag)
	}
	return argv
}

func pushCSV(argv []string, flag string, values []string) []string {
	if len(values) == 0 {
		return argv
	}
	return append(argv, flag, strings.Join(values, ","))
}

func pushRepeated(argv []string, flag string, values []string) []string {
	for _, v := range values {
		argv = append(argv, flag, v)
	}
	return argv
}
