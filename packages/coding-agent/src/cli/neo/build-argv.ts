/**
 * Translate a parsed classic argv into the argv handed to the neo (Go) binary.
 *
 * The launcher forwards every runtime-relevant flag so the Go TUI (and, through
 * it, the daemon connection) reconstructs the same runtime the classic path
 * would have built. Initial inputs — positional messages, @file mentions, and
 * image paths — are forwarded RAW (no expansion here); the daemon expands them
 * with the connection's cwd. @file args are re-prefixed with `@` to match the
 * tokens the Go arg parser expects.
 */

import type { Args } from "../args.ts";

export interface BuildNeoArgvOptions {
	/** When true, emit the leading `--isolated` flag for a per-instance backend. */
	readonly isolated: boolean;
}

export function buildNeoArgv(parsed: Args, options: BuildNeoArgvOptions): string[] {
	const argv: string[] = [];

	if (options.isolated) {
		argv.push("--isolated");
	}

	// Provider / model / thinking / auth.
	pushValue(argv, "--provider", parsed.provider);
	pushValue(argv, "--model", parsed.model);
	pushValue(argv, "--models", parsed.models?.join(","));
	pushValue(argv, "--thinking", parsed.thinking);
	pushValue(argv, "--api-key", parsed.apiKey);

	// Session selection.
	pushValue(argv, "--session", parsed.session);
	pushValue(argv, "--session-id", parsed.sessionId);
	pushValue(argv, "--session-dir", parsed.sessionDir);
	pushValue(argv, "--fork", parsed.fork);
	pushValue(argv, "--name", parsed.name);
	pushFlag(argv, "--resume", parsed.resume);
	pushFlag(argv, "--continue", parsed.continue);
	pushFlag(argv, "--no-session", parsed.noSession);

	// Approval.
	if (parsed.projectTrustOverride === true) {
		argv.push("--approve");
	} else if (parsed.projectTrustOverride === false) {
		argv.push("--no-approve");
	}

	// Tool scoping.
	pushValue(argv, "--tools", parsed.tools?.join(","));
	pushValue(argv, "--exclude-tools", parsed.excludeTools?.join(","));
	pushFlag(argv, "--no-tools", parsed.noTools);
	pushFlag(argv, "--no-builtin-tools", parsed.noBuiltinTools);

	// Resource loading.
	pushRepeated(argv, "--extension", parsed.extensions);
	pushRepeated(argv, "--skill", parsed.skills);
	pushRepeated(argv, "--prompt-template", parsed.promptTemplates);
	pushRepeated(argv, "--theme", parsed.themes);
	pushFlag(argv, "--no-extensions", parsed.noExtensions);
	pushFlag(argv, "--no-skills", parsed.noSkills);
	pushFlag(argv, "--no-prompt-templates", parsed.noPromptTemplates);
	pushFlag(argv, "--no-themes", parsed.noThemes);
	pushFlag(argv, "--no-context-files", parsed.noContextFiles);

	// Initial inputs — RAW, no expansion in the launcher.
	for (const message of parsed.messages) {
		argv.push(message);
	}
	for (const fileArg of parsed.fileArgs) {
		argv.push(`@${fileArg}`);
	}

	return argv;
}

function pushValue(argv: string[], flag: string, value: string | undefined): void {
	if (value !== undefined) {
		argv.push(flag, value);
	}
}

function pushFlag(argv: string[], flag: string, value: boolean | undefined): void {
	if (value === true) {
		argv.push(flag);
	}
}

function pushRepeated(argv: string[], flag: string, values: readonly string[] | undefined): void {
	if (values === undefined) {
		return;
	}
	for (const value of values) {
		argv.push(flag, value);
	}
}
