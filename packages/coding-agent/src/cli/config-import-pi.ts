import chalk from "chalk";
import { APP_COMMAND } from "../config.ts";
import { importLegacyPiConfig, LEGACY_PI_CONFIG_FILES } from "../legacy-pi-edits.ts";

export const CONFIG_IMPORT_PI_ARGV = "import-pi";

export const CONFIG_IMPORT_PI_USAGE = `${APP_COMMAND} config ${CONFIG_IMPORT_PI_ARGV} [${LEGACY_PI_CONFIG_FILES.join("|")} ...]`;

export function runConfigImportPi(files: readonly string[]): void {
	const result = importLegacyPiConfig(files);
	if (result.imported.length === 0 && result.failures.length === 0) {
		console.log(
			`Nothing to import: no config file in ${result.piAgentDir} changed after it was copied to ${result.agentDir}.`,
		);
		return;
	}
	for (const entry of result.imported) {
		console.log(chalk.green(`Imported ${entry.from} → ${entry.to}`));
		if (entry.backupPath !== undefined) {
			console.log(chalk.dim(`The previous ${entry.file} is saved as ${entry.backupPath}`));
		}
	}
	for (const failure of result.failures) {
		console.error(chalk.red(`Skipped ${failure.file}: ${failure.reason}`));
	}
	if (result.failures.length > 0) process.exitCode = 1;
}
