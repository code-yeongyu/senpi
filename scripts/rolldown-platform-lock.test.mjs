import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const rolldownVersion = "1.0.3";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("Rolldown platform bindings", () => {
	it("locks every native optional declared by Rolldown", () => {
		const lock = readJson(join(root, "package-lock.json"));
		const rolldown = lock.packages["node_modules/rolldown"];

		for (const [packageName, version] of Object.entries(rolldown.optionalDependencies)) {
			const binding = lock.packages[`node_modules/${packageName}`];
			assert.ok(binding, `${packageName} must be present in the root lock`);
			assert.equal(version, rolldownVersion);
			assert.equal(binding.version, rolldownVersion);
			assert.equal(binding.optional, true);
			assert.match(binding.resolved, /^https:\/\/registry\.npmjs\.org\//u);
			assert.match(binding.integrity, /^sha512-/u);
		}
	});
});
