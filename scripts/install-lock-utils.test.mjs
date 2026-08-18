import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registryMetadataError } from "./install-lock-utils.mjs";

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
