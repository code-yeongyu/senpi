import { getAgentDir } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../core/trust-manager.ts";
import { type Args, parseArgs, printHelp } from "./args.ts";
import { type HelpFlagsScope, readHelpFlagsCache } from "./help-flags-cache.ts";

export function isPlainHelpRequest(parsed: Args): boolean {
	return parsed.help === true && parsed.print !== true && parsed.mode === undefined;
}

/**
 * A help screen never prompts for project trust and never runs project-local extension code
 * the user has not already trusted: only a recorded decision, or an explicit override, lets
 * project resources in.
 */
export function resolveHelpProjectTrust(parsed: Args, cwd: string, agentDir: string): boolean {
	if (parsed.projectTrustOverride !== undefined) return parsed.projectTrustOverride;
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	return new ProjectTrustStore(agentDir).get(cwd) === true;
}

export function helpFlagsScope(parsed: Args, cwd: string, agentDir: string, projectTrusted: boolean): HelpFlagsScope {
	return {
		cwd,
		agentDir,
		cliExtensionPaths: [...(parsed.extensions ?? [])],
		noExtensions: parsed.noExtensions === true,
		projectTrusted,
	};
}

/**
 * Answer `--help` before the engine module graph is imported.
 *
 * Returns false for every launch it cannot answer from what is already known - a non-plain help
 * request, or a scope whose cached flags are missing or stale - and the normal startup path then
 * resolves the flags and refills the cache.
 */
export function tryPrintHelpWithoutEngine(argv: readonly string[]): boolean {
	let parsed: Args;
	try {
		parsed = parseArgs([...argv]);
	} catch {
		return false;
	}
	if (!isPlainHelpRequest(parsed) || parsed.diagnostics.length > 0) return false;
	if (parsed.noExtensions === true) {
		printHelp([]);
		return true;
	}
	let flags: ExtensionFlag[] | undefined;
	try {
		const cwd = process.cwd();
		const agentDir = getAgentDir();
		flags = readHelpFlagsCache(helpFlagsScope(parsed, cwd, agentDir, resolveHelpProjectTrust(parsed, cwd, agentDir)));
	} catch {
		return false;
	}
	if (!flags) return false;
	printHelp(flags);
	return true;
}
