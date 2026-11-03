#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { shippedCheckerRefusal } from "./release-version-guard.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const guard = fileURLToPath(new URL("./release-version-guard.mjs", import.meta.url));
const runGuard = (version) => spawnSync(process.execPath, [guard, version], { cwd: repoRoot, encoding: "utf8" });

describe("release version guard (senpi#5406)", () => {
	it("accepts every version form the release has cut or npm publishes, as the shipped checker orders them", () => {
		for (const version of ["2026.11.02-1", "2026.11.2-1", "2026.11.2", "2026.10.31-2", "2026.11.2-10", "2026.1.5"]) {
			assert.equal(shippedCheckerRefusal(version), undefined, version);
		}
	});

	it("refuses versions the shipped checker cannot parse or orders before their own date", () => {
		for (const version of ["2026.11.2-0", "2026.11.2-rc1", "2026.11.2.1", "2026.011.2", "omo@c6e7dd7", ""]) {
			assert.ok(shippedCheckerRefusal(version), JSON.stringify(version));
		}
	});

	it("runs as a CLI that exits 1 with the reason, and 0 for a parseable version", () => {
		const refused = runGuard("2026.11.2-0");
		assert.equal(refused.status, 1, refused.stderr);
		assert.match(refused.stderr, /orders "2026\.11\.2-0" before "2026\.11\.2"/);
		const accepted = runGuard("2026.11.02-1");
		assert.equal(accepted.status, 0, accepted.stderr);
		assert.equal(accepted.stdout, "2026.11.02-1\n");
	});

	it("is wired into the release cut and the publish workflow", () => {
		const release = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
		assert.match(release, /const version = resolveVersion\(args\);\n\tassertShippedCheckerOrders\(version\);/);
		const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
		const step = workflow.match(
			/- name: Refuse a version the shipped update checker cannot order\n {8}if: inputs\.version != ''\n[\s\S]*?run: node scripts\/release-version-guard\.mjs "\$EXPECTED_VERSION"/,
		);
		assert.ok(step, "expected the guard step in the release job");
		assert.ok(
			workflow.indexOf(step[0]) < workflow.indexOf("- name: Publish prepared version"),
			"the guard runs before the publish step",
		);
	});
});
