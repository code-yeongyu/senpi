#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildPublishArgs } from "./publish-command.mjs";

describe("npm publish command", () => {
	it("keeps registry package sources private", () => {
		for (const directory of ["ai", "agent", "tui", "pty", "telemetry", "senpi-codemode", "coding-agent"]) {
			const manifest = JSON.parse(
				readFileSync(new URL(`../packages/${directory}/package.json`, import.meta.url), "utf8"),
			);
			assert.equal(manifest.private, true, directory);
		}
	});

	it("routes root publish scripts through the guarded publisher", () => {
		const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.equal(rootPackage.scripts.publish, "npm run prepublishOnly && node scripts/publish.mjs");
		assert.equal(rootPackage.scripts["publish:dry"], "npm run prepublishOnly && node scripts/publish.mjs --dry-run");
	});

	it("rejects release publication outside GitHub Actions", () => {
		assert.throws(
			() => buildPublishArgs({ githubActions: false }),
			/GitHub Actions is required for provenance-backed npm publication/,
		);
	});

	it("rejects the live publisher before package preparation", () => {
		const env = { ...process.env };
		delete env.GITHUB_ACTIONS;
		const result = spawnSync(process.execPath, [new URL("./publish.mjs", import.meta.url).pathname], {
			encoding: "utf8",
			env,
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /GitHub Actions is required for provenance-backed npm publication/);
		assert.doesNotMatch(result.stdout, /Publishing senpi packages/);
	});

	it("uses provenance inside GitHub Actions", () => {
		assert.deepEqual(buildPublishArgs({ githubActions: true }), [
			"publish",
			"--access",
			"public",
			"--tag",
			"latest",
			"--provenance",
			"--ignore-scripts",
		]);
	});
});
