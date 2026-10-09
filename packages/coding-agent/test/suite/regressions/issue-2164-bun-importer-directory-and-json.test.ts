import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

// #2164: on Bun 1.3.x the extension importer handed directories and non-JS targets back to Bun's
// `file` namespace, which a runtime import()/require() cannot resolve there ("file:/..." not found),
// while native Bun loads both. These run under whatever `bun` is on PATH, so CI covers its version.
const importerPath = fileURLToPath(new URL("../../../src/core/extensions/bun-extension-importer.ts", import.meta.url));
const roots: string[] = [];

function fixture(files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-2164-"));
	roots.push(root);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	return root;
}

function run(root: string, scenario: string): void {
	execFileSync(
		"bun",
		[
			"--eval",
			`
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBunExtensionImporter } from ${JSON.stringify(importerPath)};
const root = ${JSON.stringify(root)};
${scenario}
`,
		],
		{ cwd: root, encoding: "utf8", timeout: 15_000 },
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Bun extension importer resolves what native Bun resolves (#2164)", () => {
	it("loads a directory extension entry through its index file or package main", () => {
		// Given: `"pi": { "extensions": ["."] }` packages, one with only index.ts and one with a main field.
		const root = fixture({
			"index-only/package.json": JSON.stringify({ name: "index-only", pi: { extensions: ["."] } }),
			"index-only/index.ts": 'export default (): string => "index";',
			"with-main/package.json": JSON.stringify({ name: "with-main", main: "lib/entry.ts" }),
			"with-main/lib/entry.ts": 'export default (): string => "main";',
		});
		// When / Then: the directory itself is the extension path.
		run(
			root,
			`
const importer = createBunExtensionImporter({});
assert.equal((await importer.import(join(root, "index-only"), { default: true }))(), "index");
assert.equal((await importer.import(join(root, "with-main"), { default: true }))(), "main");
`,
		);
	});

	it("loads JSON a CommonJS dependency requires, and resolves it to the real file", () => {
		// Given: the ajv shape, a CommonJS package requiring a JSON file from its own tree.
		const root = fixture({
			"extension.ts":
				'import dep from "json-dep"; export default () => [dep.id, import.meta.resolve("json-dep/refs/data.json")];',
			"node_modules/json-dep/package.json": JSON.stringify({ name: "json-dep", main: "index.js" }),
			"node_modules/json-dep/index.js": 'module.exports = { id: require("./refs/data.json").id };',
			"node_modules/json-dep/refs/data.json": '{"id":"data"}',
		});
		// When / Then
		run(
			root,
			`
const factory = await createBunExtensionImporter({}).import(join(root, "extension.ts"), { default: true });
const data = realpathSync(join(root, "node_modules/json-dep/refs/data.json"));
assert.deepEqual(factory(), ["data", pathToFileURL(data).href]);
`,
		);
	});

	it("loads JSON through a computed import and when it is the imported path itself", () => {
		// Given
		const root = fixture({
			"extension.ts": 'export default (name: string) => import(name, { with: { type: "json" } });',
			"data.json": '{"id":"data"}',
		});
		// When / Then
		run(
			root,
			`
const importer = createBunExtensionImporter({});
const factory = await importer.import(join(root, "extension.ts"), { default: true });
assert.deepEqual((await factory("./data.json")).default, { id: "data" });
assert.deepEqual(await importer.import(join(root, "data.json"), { default: true }), { id: "data" });
`,
		);
	});
});
