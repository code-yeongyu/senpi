// Project codemode settings for cases that drive eval cells (packages/senpi-codemode/src/config/settings.ts reads
// `<cwd>/.senpi/codemode.json`). Every timer-driven status source is turned off, because how many of its events a run
// records depends on wall-clock time: `statusEvents` (the kernels' status events) and `statusTicker` (the footer's
// once-per-second refresh of a detached cell's elapsed label). A new timer-driven status source needs its setting here.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeCodemodeSettings(cwd, settings) {
	mkdirSync(join(cwd, ".senpi"), { recursive: true });
	writeFileSync(
		join(cwd, ".senpi", "codemode.json"),
		`${JSON.stringify({ statusEvents: false, statusTicker: false, ...settings }, null, 2)}\n`,
	);
}
