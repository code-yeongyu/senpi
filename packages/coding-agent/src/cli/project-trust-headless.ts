import chalk from "chalk";
import type { ExtensionMode, ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";

function toExtensionMode(mode: AppMode): ExtensionMode {
	switch (mode) {
		case "interactive":
			return "tui";
		case "print":
		case "json":
		case "rpc":
			return mode;
	}
}

/**
 * The `project_trust` handler context of a run that cannot ask: every question answers "no answer", and notices go to
 * stderr outside the TUI. It imports no startup UI, so the RPC session path can build it without reaching the
 * terminal's synchronous config and package probes (senpi#6185).
 */
export function createHeadlessProjectTrustContext(options: {
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
			notify: (message, type = "info") => {
				if (options.mode !== "interactive") {
					const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
					console.error(color(message));
				}
			},
		},
	};
}
