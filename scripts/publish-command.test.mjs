#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildPublishArgs, requiresBuildOutput } from "./publish-command.mjs";

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

	// #5975 review: the publisher checks build output by the SOURCE manifest name, while the source-only set holds the
	// published names, so a source-only package whose source name differs (sqlite-bun) was asked for a dist/ it never has.
	it("needs no build output for a source-only package under either its source or its published name", () => {
		assert.equal(requiresBuildOutput("@earendil-works/pi-storage-sqlite-bun"), false);
		assert.equal(requiresBuildOutput("@code-yeongyu/senpi-storage-sqlite-bun"), false);
		assert.equal(requiresBuildOutput("@code-yeongyu/senpi-codemode"), false);
	});

	it("still requires build output for compiled packages", () => {
		assert.equal(requiresBuildOutput("@earendil-works/pi-ai"), true);
		assert.equal(requiresBuildOutput("@earendil-works/pi-agent-core"), true);
	});
});
