import chalk from "chalk";
import type { ExtensionMode, ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";

/**
 * The project-trust context for a mode that cannot prompt: selects and inputs resolve `undefined`, confirms
 * resolve `false`, and notices go to stderr. It does not import the startup UI, so session paths (the RPC
 * workspace verbs) can build one without reaching the TUI, keybinding and package-manager modules (senpi#6185).
 */
export function createNonInteractiveProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	hasUI: boolean;
}): ProjectTrustContext {
	return {
		cwd: options.cwd,
		mode: toExtensionMode(options.mode),
		hasUI: options.hasUI,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message, type = "info") => notifyProjectTrust(options.mode, message, type),
		},
	};
}

export function toExtensionMode(mode: AppMode): ExtensionMode {
	switch (mode) {
		case "interactive":
			return "tui";
		case "print":
		case "json":
		case "rpc":
			return mode;
	}
}

export function notifyProjectTrust(mode: AppMode, message: string, type: "info" | "warning" | "error"): void {
	if (mode !== "interactive") {
		const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
		console.error(color(message));
	}
}
