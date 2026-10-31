import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as publicModule from "../../src/core/pending-input-public.ts";

// senpi#3549: the pending-input module is published as one subpath that other owners embed.

describe("@code-yeongyu/senpi/pending-input", () => {
	it("exports the reducer, the projection and the store, and nothing node-bound", () => {
		expect(Object.keys(publicModule).sort()).toEqual([
			"PENDING_INPUT_TRANSITION",
			"PendingInputStore",
			"PendingInputStoreUnavailableError",
			"projectPendingInput",
			"reducePendingInput",
		]);
	});

	it("is declared as a package export that points at the built barrel", () => {
		const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

		expect(manifest.exports["./pending-input"]).toEqual({
			types: "./dist/core/pending-input-public.d.ts",
			import: "./dist/core/pending-input-public.js",
		});
	});
});
