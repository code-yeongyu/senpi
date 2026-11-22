import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

// CommonJS runtime semantics the extension graph must honor for real dependency graphs
// (jsdom, whatwg-url, cssom): `require.resolve`, and the partially built exports a module in
// a require cycle hands back while it is still evaluating.

const importerPath = fileURLToPath(new URL("../../src/core/extensions/bun-extension-importer.ts", import.meta.url));
const roots: string[] = [];

function fixture(source: string): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-extension-cjs-"));
	roots.push(root);
	writeFileSync(join(root, "extension.ts"), source);
	return root;
}

function commonJsPackage(root: string, name: string, files: Readonly<Record<string, string>>): string {
	const directory = join(root, "node_modules", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name, main: "index.js" }));
	for (const [file, source] of Object.entries(files)) writeFileSync(join(directory, file), source);
	return directory;
}

/** A package whose own package.json carries the given fields (for "type" resolution). */
function packageWithManifest(
	root: string,
	name: string,
	manifest: Readonly<Record<string, unknown>>,
	files: Readonly<Record<string, string>>,
): string {
	const directory = join(root, "node_modules", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name, ...manifest }));
	for (const [file, source] of Object.entries(files)) writeFileSync(join(directory, file), source);
	return directory;
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

describe("CommonJS runtime semantics in the extension graph", () => {
	it("resolves require.resolve to the dependency file's absolute path (#1838)", () => {
		// Given: a dependency that locates a sibling worker file the way jsdom's XMLHttpRequest does.
		const root = fixture('import lib from "cjs-lib"; export default () => lib.worker;');
		const directory = commonJsPackage(root, "cjs-lib", {
			"index.js": 'module.exports = { worker: require.resolve("./worker.js") };',
			"worker.js": "module.exports = null;",
		});
		// When / Then: the path is the real absolute file path, as Node's require.resolve returns.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), realpathSync(join(${JSON.stringify(directory)}, "worker.js")));
`,
		);
	});

	it("hands a module in a require cycle the partially built exports of the module still evaluating (#1838)", () => {
		// Given: a mutual require, as @acemir/cssom's CSSStyleRule <-> CSSStyleDeclaration ships.
		const root = fixture('import lib from "cjs-lib"; export default () => [lib.fromA, lib.seenByB, lib.same];');
		commonJsPackage(root, "cjs-lib", {
			"index.js":
				'exports.fromA = "a";\nconst b = require("./b.js");\nexports.seenByB = b.sawFromA;\nexports.same = require("./b.js") === b;',
			"b.js": 'const a = require("./index.js");\nexports.sawFromA = a.fromA;',
		});
		// When / Then: b sees a's partial exports, and a second require returns the cached module.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.deepEqual(factory(), ["a", "a", true]);
`,
		);
	});

	it("re-throws from a CommonJS module that failed to evaluate instead of caching its partial exports", () => {
		// Given: a dependency whose evaluation throws after it has started filling exports.
		const root = fixture('import lib from "cjs-lib"; export default () => lib;');
		commonJsPackage(root, "cjs-lib", {
			"index.js": [
				"const outcomes = [];",
				'for (const attempt of [1, 2]) { try { outcomes.push(require("./boom.js")); } catch (error) { outcomes.push(error.message); } }',
				"module.exports = outcomes;",
			].join("\n"),
			"boom.js": 'exports.partial = "set"; throw new Error("boom");',
		});
		// When / Then: every require of the failed module throws, as Node evicts a module that failed to load.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.deepEqual(factory(), ["boom", "boom"]);
`,
		);
	});

	it("evaluates a CommonJS body in sloppy mode, as node and plain bun do (#1841)", () => {
		// Given: a dependency that assigns an implicit global, which only sloppy mode allows.
		const root = fixture('import lib from "cjs-lib"; export default () => lib.value;');
		commonJsPackage(root, "cjs-lib", {
			"index.js": 'senpiImplicitGlobalFixture = "sloppy";\nmodule.exports = { value: senpiImplicitGlobalFixture };',
		});
		// When / Then: the assignment succeeds instead of throwing ReferenceError under strict mode.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), "sloppy");
`,
		);
	});

	it('still honors an explicit "use strict" directive in a CommonJS body (#1841)', () => {
		// Given: the same implicit-global assignment, in a file that opts into strict mode.
		const root = fixture('import lib from "cjs-lib"; export default () => lib;');
		commonJsPackage(root, "cjs-lib", {
			"index.js": [
				'"use strict";',
				"let thrown = null;",
				'try { senpiStrictFixture = "assigned"; } catch (error) { thrown = error.constructor.name; }',
				"module.exports = thrown;",
			].join("\n"),
		});
		// When / Then: the directive still applies, so the assignment throws.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), "ReferenceError");
`,
		);
	});

	it('honors a "use strict" directive that follows only comments (#1841)', () => {
		// Given: a directive prologue preceded by a line and a block comment, which stays a directive.
		const root = fixture('import lib from "cjs-lib"; export default () => lib;');
		commonJsPackage(root, "cjs-lib", {
			"index.js": [
				"// leading comment",
				"/* block comment */",
				'"use strict";',
				"let thrown = null;",
				'try { senpiCommentDirectiveFixture = "assigned"; } catch (error) { thrown = error.constructor.name; }',
				"module.exports = thrown;",
			].join("\n"),
		});
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), "ReferenceError");
`,
		);
	});

	it('does not treat a non-prologue "use strict" occurrence as an opt-in (#1841)', () => {
		// Given: the literal appears only in a comment, a nested function and a string value,
		// none of which is a directive prologue, so the body must stay sloppy.
		const root = fixture('import lib from "cjs-lib"; export default () => lib.value;');
		commonJsPackage(root, "cjs-lib", {
			"index.js": [
				'// "use strict";',
				'const label = "use strict";',
				'function nested() { "use strict"; return 1; }',
				'senpiNonPrologueFixture = "sloppy";',
				'module.exports = { value: senpiNonPrologueFixture + ":" + label + nested() };',
			].join("\n"),
		});
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), "sloppy:use strict1");
`,
		);
	});

	it('honors a "use strict" directive after custom directives, ASI, and comment whitespace (#1841)', () => {
		// Given: directive-prologue strings separated only by ASI and comments.
		const root = fixture('import lib from "cjs-lib"; export default () => lib;');
		commonJsPackage(root, "cjs-lib", {
			"index.js": [
				'"custom directive"',
				"/* comment between directives */",
				'"use strict"',
				"/* comment before the first statement */",
				"let thrown = null;",
				'try { senpiAsiStrictFixture = "assigned"; } catch (error) { thrown = error.constructor.name; }',
				"module.exports = thrown;",
			].join("\n"),
		});
		// When / Then: the later strict directive still opts the CommonJS body into strict mode.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), "ReferenceError");
`,
		);
	});

	it.each([
		["comparison expression", '"use strict"\n!= "";', "sloppy"],
		["negation after ASI", '"use strict"\n!false;', "ReferenceError"],
		["Unicode line separator", '// header\u2028"use strict";', "ReferenceError"],
		["Unicode paragraph separator", '// header\u2029"use strict";', "ReferenceError"],
		["Unicode identifier after ASI", '"use strict"\nin\u03c0;\nvar in\u03c0;', "ReferenceError"],
		["escaped identifier after ASI", '"use strict"\nin\\u0066oo;\nvar infoo;', "ReferenceError"],
		["Unicode custom directive", '"custom\u2028directive";\n"use strict";', "ReferenceError"],
	])("preserves directive semantics for %s (#1841)", (_name, prologue, expected) => {
		const root = fixture('import lib from "cjs-lib"; export default () => lib;');
		commonJsPackage(root, "cjs-lib", {
			"index.js": [
				prologue,
				'let result = "sloppy";',
				"try { senpiDirectiveBoundaryFixture = 1; } catch (error) { result = error.name; }",
				"module.exports = result;",
			].join("\n"),
		});
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), ${JSON.stringify(expected)});
`,
		);
	});

	it('does not inherit "type": "module" through a node_modules boundary (#1841)', () => {
		// Given: a dependency with no package.json under a type:module project package.
		const root = fixture(
			'import legacy from "./node_modules/legacy-package/index.js"; export default () => legacy.value;',
		);
		writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
		const legacy = join(root, "node_modules", "legacy-package");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "index.js"), 'module.exports = { value: "CommonJS" };');
		// When / Then: the project manifest does not turn the node_modules file into ESM.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), "CommonJS");
`,
		);
	});

	it("does not apply package type when deciding whether to wrap a TypeScript file (#1841)", () => {
		// Given: a TypeScript dependency with no module syntax below a type:module project manifest.
		const root = fixture('import side from "./side.ts"; export default () => side.value;');
		writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
		writeFileSync(join(root, "side.ts"), 'module.exports = { value: "TypeScript CommonJS" };');
		// When / Then: the loader's existing TypeScript decision still produces a CommonJS default export.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), "TypeScript CommonJS");
`,
		);
	});

	it("keeps .cjs authoritative in a type:module package and preserves CommonJS metadata (#1841)", () => {
		// Given: a .cjs dependency that needs Node-style this, metadata, and require.resolve.
		const root = fixture('import side from "./side.cjs"; export default () => side;');
		writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
		writeFileSync(join(root, "sibling.cjs"), 'module.exports = { value: "sibling" };');
		writeFileSync(
			join(root, "side.cjs"),
			[
				"module.exports = {",
				"  thisIsExports: this === module.exports,",
				"  filename: __filename,",
				"  dirname: __dirname,",
				'  resolved: require.resolve("./sibling.cjs"),',
				'  sibling: require("./sibling.cjs").value,',
				"};",
			].join("\n"),
		);
		// When / Then: .cjs wins over type:module without losing the existing wrapper contract.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.deepEqual(factory(), {
  thisIsExports: true,
  filename: realpathSync(join(root, "side.cjs")),
  dirname: realpathSync(root),
  resolved: realpathSync(join(root, "sibling.cjs")),
  sibling: "sibling",
});
`,
		);
	});

	it("names the dependency file in stack frames raised from a CommonJS body (#1841)", () => {
		// Given: a dependency that throws while evaluating.
		const root = fixture('import lib from "cjs-lib"; export default () => lib;');
		commonJsPackage(root, "cjs-lib", {
			"index.js": 'module.exports = new Error("from dependency").stack;',
		});
		// When / Then: the captured stack still attributes the frame to the dependency file.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.ok(String(factory()).includes("index.js"), "stack should name the dependency file: " + factory());
`,
		);
	});

	it('loads a .js file with only top-level await inside a "type": "module" package (#1841)', () => {
		// Given: an ESM-by-manifest .js file whose only module-level syntax is await.
		const root = fixture('import "esm-pkg"; export default () => globalThis.__senpiTypeModuleFixture;');
		packageWithManifest(
			root,
			"esm-pkg",
			{ type: "module", main: "index.js" },
			{ "index.js": "globalThis.__senpiTypeModuleFixture = await Promise.resolve(43);" },
		);
		// When / Then: it takes the ESM path instead of failing to parse inside a CommonJS wrapper.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), 43);
`,
		);
	});

	it("keeps a .mjs file with top-level await and no import or export on the ESM path", () => {
		// Given: an ES module by extension whose only module-level syntax is await.
		const root = fixture('import "./side.mjs"; export default () => globalThis.__senpiSideEffect;');
		writeFileSync(join(root, "side.mjs"), "globalThis.__senpiSideEffect = await Promise.resolve(41);");
		// When / Then: it evaluates as a module instead of failing to parse inside a CommonJS wrapper.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), 41);
`,
		);
	});
});
