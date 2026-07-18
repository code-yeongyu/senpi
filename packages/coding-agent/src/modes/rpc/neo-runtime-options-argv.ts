/**
 * Convert a NeoRuntimeOptions payload into the classic argv a child
 * `senpi --mode rpc` worker consumes for runtime construction.
 *
 * This is the daemon-side inverse of cli/neo/build-argv.ts: the launcher turns
 * classic argv into neo argv; here the daemon turns the connection's
 * NeoRuntimeOptions back into classic runtime-construction argv for its worker
 * process. Initial inputs (messages / fileArgs) are intentionally NOT emitted —
 * an rpc worker does not consume them as an initial prompt. The plain positional
 * `messages` text is delivered separately as a `prompt` command; launch-time
 * @file expansion is not yet implemented, so `fileArgs` are surfaced as a
 * one-line non-fatal notice in the Go TUI rather than expanded.
 */

import type { NeoRuntimeOptions } from "./neo-runtime-options.ts";

/** Build the classic runtime-construction argv for `senpi --mode rpc`. */
export function neoRuntimeOptionsToRpcArgv(options: NeoRuntimeOptions): string[] {
	const argv: string[] = ["--mode", "rpc"];

	pushValue(argv, "--provider", options.provider);
	pushValue(argv, "--model", options.model);
	pushValue(argv, "--models", options.models?.join(","));
	pushValue(argv, "--thinking", options.thinking);
	pushValue(argv, "--api-key", options.apiKey);

	pushValue(argv, "--session", options.session);
	pushValue(argv, "--session-id", options.sessionId);
	pushValue(argv, "--session-dir", options.sessionDir);
	pushValue(argv, "--fork", options.fork);
	pushValue(argv, "--name", options.name);
	pushFlag(argv, "--resume", options.resume);
	pushFlag(argv, "--continue", options.continue);
	pushFlag(argv, "--no-session", options.noSession);

	if (options.projectTrustOverride === true) {
		argv.push("--approve");
	} else if (options.projectTrustOverride === false) {
		argv.push("--no-approve");
	}

	pushValue(argv, "--tools", options.tools?.join(","));
	pushValue(argv, "--exclude-tools", options.excludeTools?.join(","));
	pushFlag(argv, "--no-tools", options.noTools);
	pushFlag(argv, "--no-builtin-tools", options.noBuiltinTools);

	pushRepeated(argv, "--extension", options.extensions);
	pushRepeated(argv, "--skill", options.skills);
	pushRepeated(argv, "--prompt-template", options.promptTemplates);
	pushRepeated(argv, "--theme", options.themes);
	pushFlag(argv, "--no-extensions", options.noExtensions);
	pushFlag(argv, "--no-skills", options.noSkills);
	pushFlag(argv, "--no-prompt-templates", options.noPromptTemplates);
	pushFlag(argv, "--no-themes", options.noThemes);
	pushFlag(argv, "--no-context-files", options.noContextFiles);
	pushValue(argv, "--system-prompt", options.systemPrompt);
	pushRepeated(argv, "--append-system-prompt", options.appendSystemPrompt);

	// Extension (unknown) flags: `--<name>` for boolean-true, `--<name> <value>` otherwise.
	if (options.unknownFlags) {
		for (const [name, value] of Object.entries(options.unknownFlags)) {
			if (value === true) {
				argv.push(`--${name}`);
			} else if (value !== false) {
				argv.push(`--${name}`, String(value));
			}
		}
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
	if (values === undefined) return;
	for (const value of values) {
		argv.push(flag, value);
	}
}
