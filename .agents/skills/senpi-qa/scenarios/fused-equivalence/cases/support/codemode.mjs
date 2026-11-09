// Project codemode settings for cases that drive eval cells (packages/senpi-codemode/src/config/settings.ts reads
// `<cwd>/.senpi/codemode.json`). Status ticks are timer-driven, so every EQ case turns them off.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeCodemodeSettings(cwd, settings) {
	mkdirSync(join(cwd, ".senpi"), { recursive: true });
	writeFileSync(
		join(cwd, ".senpi", "codemode.json"),
		`${JSON.stringify({ statusEvents: false, ...settings }, null, 2)}\n`,
	);
}
