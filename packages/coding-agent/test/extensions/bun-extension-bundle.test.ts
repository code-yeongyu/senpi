import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const importerPath = fileURLToPath(new URL("../../src/core/extensions/bun-extension-importer.ts", import.meta.url));

describe("Bun extension bundling", () => {
	it("bundles the Bun extension entry graph without bundler warnings", async () => {
		// Given: releases ship this graph through esbuild (scripts/build-coding-agent-bundle.mjs).
		// When
		const result = await build({
			bundle: true,
			entryPoints: [importerPath],
			format: "esm",
			logLevel: "silent",
			platform: "node",
			target: "node22.19",
			write: false,
		});
		// Then: esbuild accepts only a fully static import() second argument, so runtime
		// attributes must never reach the bundler as an import expression it has to read.
		expect(result.warnings.map((warning) => `${warning.id}: ${warning.text}`)).toEqual([]);
	});
});
