import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectJsonIndent, registryMetadataError, serializeLockfile } from "./install-lock-utils.mjs";

describe("lockfile serialization", () => {
	it("keeps the lockfile's own indentation so a generator run is a content-only edit", () => {
		const tabbed = '{\n\t"name": "senpi-monorepo",\n\t"packages": {}\n}\n';
		const spaced = '{\n  "name": "senpi-monorepo",\n  "packages": {}\n}\n';

		assert.equal(detectJsonIndent(tabbed), "\t");
		assert.equal(detectJsonIndent(spaced), "  ");
		assert.equal(serializeLockfile(JSON.parse(tabbed), detectJsonIndent(tabbed)), tabbed);
		assert.equal(serializeLockfile(JSON.parse(spaced), detectJsonIndent(spaced)), spaced);
	});

	it("falls back to a tab when the lockfile has no detectable indentation", () => {
		assert.equal(detectJsonIndent('{"name":"senpi-monorepo"}'), "\t");
		assert.equal(serializeLockfile({ name: "senpi-monorepo" }, detectJsonIndent("{}")), '{\n\t"name": "senpi-monorepo"\n}\n');
	});
});

describe("registryMetadataError", () => {
	it("rejects incomplete external registry entries", () => {
		assert.equal(
			registryMetadataError("node_modules/example", {
				version: "1.0.0",
				resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
			}),
			"node_modules/example is missing integrity registry metadata",
		);
	});

	it("accepts complete registry entries and bundled workspaces", () => {
		assert.equal(
			registryMetadataError("node_modules/example", {
				version: "1.0.0",
				resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
				integrity: "sha512-test",
			}),
			undefined,
		);
		assert.equal(
			registryMetadataError("node_modules/@earendil-works/pi-ai", {
				version: "2026.8.13",
				inBundle: true,
			}),
			undefined,
		);
	});
});
