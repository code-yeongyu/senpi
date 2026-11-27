import chalk from "chalk";
import type { EngineDiagnostic } from "../engine/result.ts";

/** Prints engine diagnostics on stderr the way the package and config commands always have. */
export function renderEngineDiagnostics(diagnostics: readonly EngineDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		switch (diagnostic.kind) {
			case "project_trust":
				console.error(chalk.yellow(`Warning: ${diagnostic.message}`));
				break;
			case "settings":
				console.error(
					chalk.yellow(`Warning (${diagnostic.context}, ${diagnostic.scope} settings): ${diagnostic.message}`),
				);
				if (diagnostic.stack) console.error(chalk.dim(diagnostic.stack));
				break;
			case "runtime": {
				const color =
					diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
				const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
				console.error(color(`${prefix}${diagnostic.message}`));
				break;
			}
			default: {
				const exhaustive: never = diagnostic;
				return exhaustive;
			}
		}
	}
}
