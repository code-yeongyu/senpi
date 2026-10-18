#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, it } from "node:test";
import { rewritePublishManifest } from "./publish-manifest.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const repoRoot = new URL("..", import.meta.url);

describe("publish manifest rewrite", () => {
	it("gives the publisher repository-relative package directories", () => {
		const packages = getPublicWorkspacePackages();
		assert.ok(packages.length > 0);
		for (const { name, directory } of packages) {
			assert.ok(!isAbsolute(directory) && !directory.startsWith(".."), `${name}: ${directory} must be repository-relative`);
			assert.ok(existsSync(new URL(`${directory}/package.json`, repoRoot)), `${name}: ${directory} must hold its manifest`);
		}
	});

	it("targets the Senpi fork for OIDC provenance", () => {
		const manifest = {
			name: "@earendil-works/pi-ai",
			private: true,
			repository: "git+https://github.com/earendil-works/pi.git",
		};

		rewritePublishManifest(manifest, {
			directory: "packages/ai",
			name: "@code-yeongyu/senpi-ai",
		});

		assert.deepEqual(manifest, {
			name: "@code-yeongyu/senpi-ai",
			repository: {
				type: "git",
				url: "git+https://github.com/code-yeongyu/senpi.git",
				directory: "packages/ai",
			},
		});
	});

	it("pins the codemode peer to the exact CalVer revision", () => {
		const manifest = {
			name: "@code-yeongyu/senpi-codemode",
			version: "2026.8.3-2",
			private: true,
			peerDependencies: {
				"@code-yeongyu/senpi": "*",
			},
		};

		rewritePublishManifest(manifest, {
			directory: "packages/senpi-codemode",
			name: "@code-yeongyu/senpi-codemode",
		});

		assert.deepEqual(manifest.peerDependencies, {
			"@code-yeongyu/senpi": "2026.8.3-2",
		});
		assert.equal(manifest.private, undefined);
	});
});
