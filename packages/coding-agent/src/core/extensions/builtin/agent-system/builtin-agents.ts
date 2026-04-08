import type { AgentInfo, AgentMode } from "./agent-types.js";
import { fromConfig, merge } from "./permission.js";

export const BUILTIN_AGENTS: Record<string, AgentInfo> = {
	general: {
		name: "general",
		description:
			"General-purpose agent for complex multi-step tasks. Use to execute multiple units of work in parallel.",
		mode: "subagent" as AgentMode,
		native: true,
		permission: fromConfig({ "*": "allow", task: "deny", todowrite: "deny" }),
	},
	explore: {
		name: "explore",
		description: "Fast codebase exploration agent. Read-only. Finds files, searches code, reads contents.",
		mode: "subagent" as AgentMode,
		native: true,
		permission: merge(
			fromConfig({ "*": "deny" }),
			fromConfig({
				read: "allow",
				grep: "allow",
				find: "allow",
				ls: "allow",
				bash: "allow",
			}),
		),
		prompt: `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Guidelines:
- Search file contents by regex or literal pattern when you need to locate usages or definitions
- Read files directly when you already know the path
- List directory contents to build a map of unfamiliar areas
- Return file paths as absolute paths
- Do not create any files or modify the system state
Complete the search request efficiently and report findings clearly.`,
	},
};
