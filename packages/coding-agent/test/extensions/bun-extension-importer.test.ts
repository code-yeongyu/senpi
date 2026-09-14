import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

const importerPath = fileURLToPath(new URL("../../src/core/extensions/bun-extension-importer.ts", import.meta.url));
const roots: string[] = [];

// Windows forbids '?' in file names; spaces, '#' and '%' still exercise URL escaping.
function fixture(source: string, prefix = `senpi-extension # % ${process.platform === "win32" ? "" : "? "}`): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	writeFileSync(join(root, "extension.ts"), source);
	return root;
}

function packageFixture(root: string, name: string, source: string): void {
	const directory = join(root, "node_modules", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
	writeFileSync(join(directory, "index.js"), source);
}

function run(root: string, scenario: string): void {
	execFileSync(
		"bun",
		[
			"--eval",
			`
import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBunExtensionImporter } from ${JSON.stringify(importerPath)};
const root = ${JSON.stringify(root)};
const entry = join(root, "extension.ts");
${scenario}
`,
		],
		{ cwd: root, encoding: "utf8", timeout: 15_000 },
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native Bun extension importer", () => {
	it("preserves host object identity when virtual exports round-trip through an extension", () => {
		// Given: a shadow package whose exports must lose to the host namespace.
		const root = fixture(
			'import { token, identity } from "extension-host"; export default () => identity(token);',
			"senpi-host-identity-",
		);
		packageFixture(root, "extension-host", "export const token = {}; export const identity = value => value;");
		// When: import and invoke a real TypeScript extension through Bun.
		run(
			root,
			`
const token = {};
const importer = await createBunExtensionImporter({ "extension-host": { token, identity: value => value } });
const factory = await importer.import(entry, { default: true });
// Then: no serialization or duplicate host namespace.
assert.equal(factory(), token, "host-identity-mismatch");
`,
		);
	});

	it("isolates the full local graph when two importer batches load the same root", () => {
		// Given: a local TypeScript dependency with an identity-bearing export.
		const root = fixture('import { token } from "./helper.ts"; export default () => token;');
		writeFileSync(join(root, "helper.ts"), "export const token: object = {};\n");
		// When: create independent batches, including overlapping imports.
		run(
			root,
			`
const first = await createBunExtensionImporter({});
const second = await createBunExtensionImporter({});
const [a, b] = await Promise.all([first.import(entry, { default: true }), second.import(entry, { default: true })]);
// Then: cache-busting only the root cannot satisfy this assertion.
assert.notEqual(a(), b());
`,
		);
	});

	it("observes helper edits when a fresh generation reloads unchanged extension source", () => {
		// Given: the root remains unchanged across reload.
		const root = fixture('import { value } from "./helper.ts"; export default () => value;');
		writeFileSync(join(root, "helper.ts"), 'export const value: string = "before";\n');
		// When: change only the dependency between importer batches.
		run(
			root,
			`
const first = await createBunExtensionImporter({});
const before = await first.import(entry, { default: true });
writeFileSync(join(root, "helper.ts"), 'export const value: string = "after";');
const second = await createBunExtensionImporter({});
const after = await second.import(entry, { default: true });
// Then: fresh dependency evaluation, with the old generation intact.
assert.equal(before(), "before");
assert.equal(after(), "after");
`,
		);
	});

	it("shares static and computed dynamic relative imports within a generation", () => {
		// Given: the dynamic specifier cannot be statically rewritten by a bundler.
		const root = fixture(`import * as helper from "./helper.ts";
export default async (name: string) => [helper, await import(name)];`);
		writeFileSync(join(root, "helper.ts"), "export const token = {};\n");
		// When: invoke after both generations have registered their hooks.
		run(
			root,
			`
const first = await createBunExtensionImporter({});
const factory = await first.import(entry, { default: true });
await createBunExtensionImporter({});
const [staticModule, dynamicModule] = await factory("./helper.ts");
// Then: dynamic resolution retains its importing generation, not the latest one.
assert.equal(staticModule, dynamicModule);
`,
		);
	});

	it("preserves real import metadata when paths contain URL-special characters", () => {
		// Given: metadata appears both as direct properties and as the complete object.
		const root = fixture("export default () => [import.meta.url, import.meta.path, import.meta.dir, import.meta];");
		// When
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
const [url, path, dir, meta] = factory();
// Then
assert.equal(url, pathToFileURL(realpathSync(entry)).href);
assert.equal(path, realpathSync(entry));
assert.equal(dir, realpathSync(root));
assert.equal(meta.url, url);
assert.equal(meta.path, path);
`,
		);
	});

	it("resolves packages from the importing directory while leaving builtins native", () => {
		// Given: an external package reachable only from the fixture's node_modules.
		const root = fixture(
			'import { value } from "local-package"; import { readFileSync } from "node:fs"; export default () => ({ value, readFileSync });',
		);
		packageFixture(root, "local-package", 'export { value } from "./nested.js";');
		writeFileSync(join(root, "node_modules/local-package/nested.js"), "export const value = 73;");
		// When / Then
		run(
			root,
			`
const { readFileSync } = await import("node:fs");
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory().value, 73);
assert.equal(factory().readFileSync, readFileSync);
`,
		);
	});

	it("shares root identity when a JavaScript helper imports the TypeScript entry back", () => {
		// Given: a cycle through realpath resolution (including a symlinked temp directory).
		const root = fixture(
			'import { getToken } from "./helper.js"; export const token = {}; export default () => [token, getToken()];',
		);
		writeFileSync(
			join(root, "helper.js"),
			'import { token } from "./extension.ts"; export const getToken = () => token;',
		);
		// When / Then
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
const [rootToken, helperToken] = factory();
assert.equal(rootToken, helperToken);
`,
		);
	});

	it("loads synchronous CommonJS dependency chains without changing require ordering", () => {
		// Given: native require cannot wait for an asynchronous runtime onLoad hook.
		const root = fixture('const helper = require("./helper.cjs"); export default () => helper();');
		writeFileSync(join(root, "helper.cjs"), 'const { value } = require("./leaf.cjs"); module.exports = () => value;');
		writeFileSync(join(root, "leaf.cjs"), "exports.value = 83;");
		// When / Then
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), 83);
`,
		);
	});

	it("accepts a shebang when transpiling a TypeScript extension", () => {
		// Given
		const root = fixture("#!/usr/bin/env bun\nexport default () => 91;");
		// When / Then
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), 91);
`,
		);
	});

	it("defers optional dynamic dependency resolution until the import is executed", () => {
		// Given: an unavailable optional dependency behind a runtime condition.
		const root = fixture('export default (enabled: boolean) => enabled ? import("./optional-missing.ts") : 97;');
		// When / Then: transforming the entry must not resolve a disabled import.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(false), 97);
`,
		);
	});

	it("propagates transform and resolution errors when extension input is malformed", () => {
		// Given
		const root = fixture("export const broken: = ;");
		// When / Then: actual parse rejection, not an apparent successful default export.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
await assert.rejects(importer.import(entry, { default: true }));
writeFileSync(entry, 'import "./missing.ts"; export default () => {};');
const fresh = await createBunExtensionImporter({});
await assert.rejects(fresh.import(entry, { default: true }));
`,
		);
	});
});
