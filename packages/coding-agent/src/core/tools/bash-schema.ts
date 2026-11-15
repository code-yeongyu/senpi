import { type Static, Type } from "typebox";
import type { ShellTrust } from "../../engine-trust/shell-trust.ts";
import type { TruncationResult } from "./truncate.ts";

export const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, rg, find, etc.)",
	guidelines: ["PI_* env vars = current model + session details."],
	fullGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

/**
 * Result for programmatic callers such as codemode scripts. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
export const bashOutputSchema = Type.Object({
	output: Type.String({
		description:
			"Combined stdout and stderr, up to 1 MiB. Longer output keeps its first and last 512 KiB around an omission marker.",
	}),
	truncated: Type.Boolean({ description: "Whether `output` omits part of the command output" }),
	full_output_path: Type.Optional(Type.String({ description: "Temp file with the full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	trust?: ShellTrust;
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	fullPromptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	fullPromptGuidelines: bashToolSystemPromptContribution.fullGuidelines,
	tempFilePrefix: "pi-bash",
};
