// The fused-equivalence cases record every status update a run emits, so a status source driven by a timer makes the
// recorded event count depend on wall-clock time (senpi#7535: the footer ticker's per-second refresh made E08 pass 1 run
// in 5). codemode names its status settings `status*` (packages/senpi-codemode/src/config/settings.ts); this test reads
// every boolean `status*` key of the settings schema and fails until the cases' settings helper turns it off.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeCodemodeSettings } from "../../scenarios/fused-equivalence/cases/support/codemode.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const settingsSource = join(repoRoot, "packages", "senpi-codemode", "src", "config", "settings.ts");

/** The `status*` keys the codemode settings schema declares as optional booleans. */
function statusSettingKeys() {
	const source = readFileSync(settingsSource, "utf8");
	return [...source.matchAll(/^\t\t(status[A-Za-z]*): Type\.Optional\(Type\.Boolean\(\)\),$/gm)].map((match) => match[1]);
}

test("the schema declares the status settings this test guards", () => {
	assert.deepEqual(statusSettingKeys().sort(), ["statusEvents", "statusTicker"]);
});

test("the cases' settings helper turns every status setting off", () => {
	const cwd = mkdtempSync(join(tmpdir(), "eq-codemode-settings-"));
	try {
		writeCodemodeSettings(cwd, {});
		const written = JSON.parse(readFileSync(join(cwd, ".senpi", "codemode.json"), "utf8"));
		for (const key of statusSettingKeys()) assert.equal(written[key], false, `${key} must be false for EQ cases`);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
