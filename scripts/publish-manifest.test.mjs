#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { rewritePublishManifest } from "./publish-manifest.mjs";

const publisherSource = readFileSync(new URL("./publish.mjs", import.meta.url), "utf8");

describe("publish manifest rewrite", () => {
	it("passes repository-relative package directories directly", () => {
		assert.match(publisherSource, /directory: pkg\.directory/);
		assert.doesNotMatch(publisherSource, /repoRoot|rootDir/);
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
