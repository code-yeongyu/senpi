import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

const importerPath = fileURLToPath(new URL("../../src/core/extensions/bun-extension-importer.ts", import.meta.url));
const roots: string[] = [];
function fixture(source: string, prefix = "senpi-regressions-"): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	writeFileSync(join(root, "extension.ts"), source);
	return root;
}
function run(root: string, scenario: string): void {
	execFileSync(
		"bun",
		[
			"--eval",
			`
import assert from "node:assert/strict";
import { writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import * as importerApi from ${JSON.stringify(importerPath)};
const { createBunExtensionImporter } = importerApi;
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

describe("Bun extension review regressions", () => {
	it("attributes parser diagnostics to the real file when TypeScript is malformed", () => {
		// Given
		const root = fixture("export const broken: = ;");
		// When / Then: positions and attribution, not incidental diagnostic prose.
		run(
			root,
			`
const importer = createBunExtensionImporter({});
await assert.rejects(importer.import(entry, { default: true }), error => {
  assert.equal(error.filename, realpathSync(entry));
  assert.deepEqual(error.diagnostics.map(d => [d.line, d.column]), [[1, 22], [1, 24]]);
  assert(error.message.includes(error.filename + ":1:22"));
  return true;
});
`,
		);
	});
	it("bounds generation registrations when superseded importers are disposed", () => {
		// Given: real generation ownership, without mocking module loading.
		const root = fixture("export default () => name => import(name);");
		writeFileSync(join(root, "helper.ts"), "export const token = {};");
		// When / Then: old factories stay usable until their owning importer is disposed.
		run(
			root,
			`
const live = createBunExtensionImporter({});
const factory = await live.import(entry, { default: true });
const load = factory();
const before = await load("./helper.ts");
for (let n = 0; n < 50; n++) {
  const discarded = createBunExtensionImporter({});
  await discarded.import(entry, { default: true });
  discarded.dispose();
}
assert.equal((await load("./helper.ts")).token, before.token);
assert.equal(importerApi.bunExtensionImporterStats().generations, 1);
assert.equal(importerApi.bunExtensionImporterStats().plugins, 1);
live.dispose();
await assert.rejects(live.import(entry, { default: true }), { name: "ExtensionGenerationDisposedError" });
await assert.rejects(load("./unloaded.ts"), { name: "ExtensionGenerationDisposedError" });
`,
		);
	});

	it("collects discarded graphs while a reachable old factory keeps dynamic imports usable", () => {
		// Given: no importer variable survives, only the returned factory does.
		const root = fixture("export default name => import(name);");
		writeFileSync(join(root, "helper.ts"), "export const value = 41;");
		// When: cross a job boundary (the WeakRef keep-alive boundary), then force GC.
		run(
			root,
			`
const factory = await createBunExtensionImporter({}).import(entry, { default: true });
for (let n = 0; n < 2000; n++) createBunExtensionImporter({});
await new Promise(setImmediate);
Bun.gc(true);
// Then: no timing-dependent finalizer wait; dereference observes actual liveness.
assert.equal(importerApi.bunExtensionImporterStats().generations, 1);
assert.equal((await factory("./helper.ts")).value, 41);
`,
		);
	});

	it("shares computed require with static imports and reloads it in a fresh generation", () => {
		// Given
		const root = fixture('import * as helper from "./helper.js"; export default name => [helper, require(name)];');
		writeFileSync(join(root, "helper.js"), "export const value = 41; export const token = {};");
		// When
		run(
			root,
			`
const first = createBunExtensionImporter({});
const a = await first.import(entry, { default: true });
const before = a("./helper.js");
writeFileSync(join(root, "helper.js"), "export const value = 42; export const token = {};");
const second = createBunExtensionImporter({});
const b = await second.import(entry, { default: true });
const after = b("./helper.js");
// Then
assert.equal(before[0], before[1]);
assert.equal(after[0], after[1]);
assert.notEqual(before[1], after[1]);
assert.deepEqual([before[1].value, after[1].value], [41, 42]);
`,
		);
	});

	it("loads computed-only CommonJS chains synchronously inside their generation", () => {
		// Given: neither helper is statically discoverable from the root.
		const root = fixture("export default name => require(name)();");
		writeFileSync(
			join(root, "helper.cjs"),
			'const name = "./leaf.cjs"; const leaf = require(name); module.exports = () => leaf;',
		);
		writeFileSync(join(root, "leaf.cjs"), "module.exports = { value: 41 };");
		// When / Then
		run(
			root,
			`
const first = createBunExtensionImporter({});
const a = await first.import(entry, { default: true });
const before = a("./helper.cjs");
writeFileSync(join(root, "leaf.cjs"), "module.exports = { value: 42 };");
const second = createBunExtensionImporter({});
const b = await second.import(entry, { default: true });
assert.equal(a("./helper.cjs"), before);
assert.notEqual(b("./helper.cjs"), before);
assert.equal(b("./helper.cjs").value, 42);
`,
		);
	});

	for (const [extension, contents, expected] of [
		["json", '{"value":41}', { value: 41 }],
		["toml", "value = 41", { value: 41 }],
		["txt", "data-41", "data-41"],
	] as const) {
		// Bun's own native data loader rejects literal '?' even without plugins.
		for (const prefix of ["senpi-data-", "senpi-data # % "]) {
			it(`uses Bun's native ${extension} loader when an extension imports data from ${prefix}`, () => {
				// Given
				const root = fixture(`import value from "./helper.${extension}"; export default () => value;`, prefix);
				writeFileSync(join(root, `helper.${extension}`), contents);
				// When / Then
				run(
					root,
					`
const importer = createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.deepEqual(factory(), ${JSON.stringify(expected)});
`,
				);
			});
		}
	}

	it("preserves import attributes when a native file loader handles an asset", () => {
		// Given
		const root = fixture('import value from "./asset.bin" with { type: "file" }; export default () => value;');
		writeFileSync(join(root, "asset.bin"), "asset-bytes");
		// When / Then
		run(
			root,
			`
const factory = await createBunExtensionImporter({}).import(entry, { default: true });
assert.equal(factory(), realpathSync(join(root, "asset.bin")));
`,
		);
	});

	it("resolves computed packages from a symlinked extension's nested node_modules chain", () => {
		// Given: package resolution must use the symlink target, not the caller's cwd.
		const root = fixture('export { default } from "./linked/nested/extension.ts";');
		const target = join(root, "target");
		const pkg = join(target, "node_modules", "local-package");
		mkdirSync(pkg, { recursive: true });
		mkdirSync(join(target, "nested"));
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
		writeFileSync(join(pkg, "index.js"), "export const token = {};");
		writeFileSync(
			join(target, "nested", "extension.ts"),
			'import * as helper from "local-package"; export default async name => [helper, await import(name)];',
		);
		symlinkSync(target, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
		// When / Then
		run(
			root,
			`
const importer = createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
const [staticModule, computedModule] = await factory("local-package");
assert.equal(staticModule, computedModule);
`,
		);
	});
});
