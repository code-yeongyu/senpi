#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildPublishArgs } from "./publish-command.mjs";

describe("npm publish command", () => {
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

	// senpi#6645 review (32e83a5610, finding 1): on a ref other than main the publish-only job still holds id-token:
	// write, so publish.mjs itself refuses a live run there, before any package is prepared.
	it("refuses a live publish in GitHub Actions on a ref other than refs/heads/main, before package preparation", () => {
		for (const ref of ["refs/heads/ci/6642-forced-suite-matrix", undefined]) {
			const env = { ...process.env, GITHUB_ACTIONS: "true" };
			delete env.GITHUB_REF;
			if (ref) env.GITHUB_REF = ref;
			const result = spawnSync(process.execPath, [new URL("./publish.mjs", import.meta.url).pathname], { encoding: "utf8", env });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /only from refs\/heads\/main/);
			assert.doesNotMatch(result.stdout, /Publishing senpi packages/);
		}
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
