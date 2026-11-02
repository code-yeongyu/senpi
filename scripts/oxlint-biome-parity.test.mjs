#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { oxlintLines, PORTS, verdictsPath } from "./oxlint-biome-parity.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const verdicts = JSON.parse(readFileSync(verdictsPath, "utf8"));

describe("rules ported to oxlint flag exactly what Biome 2.5.14 flags", () => {
	it("records a Biome verdict for every ported rule", () => {
		assert.equal(verdicts.biome, "@biomejs/biome@2.5.14");
		assert.deepEqual(Object.keys(verdicts.rules).sort(), Object.keys(PORTS).sort());
	});

	for (const [rule, port] of Object.entries(PORTS)) {
		it(`${rule} flags the same corpus lines as Biome`, () => {
			assert.deepEqual(oxlintLines(rule, port.corpus), verdicts.rules[rule]);
		});
	}
});

describe("oxlint configuration", () => {
	it("enables no type-aware rule, because lint runs without --type-aware and would skip it silently", () => {
		const oxlint = join(root, "node_modules", ".bin", "oxlint");
		const run = (args) => {
			const result = spawnSync(oxlint, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
			assert.equal(result.status, 0, result.stderr);
			return JSON.parse(result.stdout);
		};
		const typeAware = new Set(
			run(["--rules", "-f", "json"])
				.filter((rule) => rule.type_aware)
				.map((rule) => `${rule.scope}/${rule.value}`),
		);
		assert.ok(typeAware.size > 0, "oxlint --rules must list its type-aware rules");
		const level = (setting) => (Array.isArray(setting) ? setting[0] : setting);
		const enabled = Object.entries(run(["--print-config"]).rules)
			.filter(([name, setting]) => typeAware.has(name) && !["off", "allow", 0].includes(level(setting)))
			.map(([name]) => name);
		assert.deepEqual(enabled, []);
	});
});
