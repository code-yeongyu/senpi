import type { ExtensionRunner } from "./extensions/runner.ts";

export interface PromptSizeStartupNotes {
	readonly mcp?: {
		readonly count: number;
		readonly names: readonly string[];
		readonly note: string;
	};
	readonly thirdPartySessionStart: {
		readonly names: readonly string[];
		readonly note: string;
	};
}

/**
 * Filesystem lookups behind a sizes-only report. They read synchronously, so only the one-shot
 * `--print-prompt-sizes` CLI supplies them; the shared RPC host never runs them on a session path.
 */
export interface PromptSizeInventory {
	/** Nearest `package.json` name of an extension path. */
	packageNameOf(path: string): string | undefined;
	/** Configured MCP server names, from config only: never attaches or exposes endpoints. */
	mcpServerNames(input: { readonly cwd: string; readonly runner: ExtensionRunner }): readonly string[];
}

export function promptSizeStartupNotes(input: {
	readonly cwd: string;
	readonly runner: ExtensionRunner;
	readonly extensionNames: ReadonlyMap<string, string>;
	readonly inventory: PromptSizeInventory | undefined;
	readonly sizesOnlyStartup: boolean;
}): PromptSizeStartupNotes {
	const thirdPartySessionStart = {
		names: input.runner.getThirdPartySessionStartPaths().map((path) => input.extensionNames.get(path) ?? "extension"),
		note: "these third-party session_start hooks ran during startup and may have used the network",
	};
	if (!input.sizesOnlyStartup || input.inventory === undefined) return { thirdPartySessionStart };
	const servers = [...input.inventory.mcpServerNames({ cwd: input.cwd, runner: input.runner })].sort();
	return {
		mcp: { count: servers.length, names: servers, note: "not attached; tool sizes exclude them" },
		thirdPartySessionStart,
	};
}
