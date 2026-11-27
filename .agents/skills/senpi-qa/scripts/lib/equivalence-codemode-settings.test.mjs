// The fused-equivalence cases record every status update a run emits, so a status source driven by a timer makes the
// recorded event count depend on wall-clock time (senpi#7535: the footer ticker's per-second refresh made E08 pass 1 run
// in 5). codemode names its status settings `status*` (packages/senpi-codemode/src/config/settings.ts); this test reads
// every boolean `status*` property of the exported settings schema and fails until the cases' settings helper turns it off.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codemodeSettingsSchema } from "../../../../../packages/senpi-codemode/src/config/settings.ts";
import { writeCodemodeSettings } from "../../scenarios/fused-equivalence/cases/support/codemode.mjs";

/** The `status*` keys the codemode settings schema declares as booleans. */
function statusSettingKeys() {
	return Object.entries(codemodeSettingsSchema.properties)
		.filter(([key, schema]) => key.startsWith("status") && schema.type === "boolean")
		.map(([key]) => key);
}

test("the schema read finds the footer ticker's status setting", () => {
	assert.ok(statusSettingKeys().includes("statusTicker"), `status settings found: ${statusSettingKeys().join(", ")}`);
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
