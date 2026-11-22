#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedCatalog } from "./model-catalog-refresh.mjs";

describe("changedCatalog (senpi#2943)", () => {
	it("names providers from the files the generator writes: data/<id>.json and <id>.models.ts", () => {
		const change = changedCatalog(
			[
				" M packages/ai/src/models.generated.ts",
				" M packages/ai/src/providers/data/nvidia.json",
				" M packages/ai/src/providers/nvidia.models.ts",
				"?? packages/ai/src/providers/data/newco.json",
				"?? packages/ai/src/providers/newco.models.ts",
				" M packages/ai/src/providers/data/.manifest.json",
			].join("\n"),
		);
		assert.deepEqual(change.providers, ["newco", "nvidia"]);
		assert.equal(change.files.length, 6);
	});

	it("reports nothing when the regeneration left the catalog unchanged", () => {
		assert.deepEqual(changedCatalog(""), { providers: [], files: [] });
	});
});
