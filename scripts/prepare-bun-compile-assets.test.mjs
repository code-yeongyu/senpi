import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { inlineCssTreeCompileData } from "./prepare-bun-compile-assets.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prepareAssetsScript = join(repoRoot, "scripts", "prepare-bun-compile-assets.mjs");
const CSS_TREE_VERSION = "3.2.1";
const PATCH = { atrules: { charset: { prelude: "<string>" } }, properties: { color: { syntax: "<color>" } } };
const AT_RULES = { "@media": { syntax: "@media <media-query-list> { <rule-list> }" } };
const PROPERTIES = { color: { syntax: "<color>" } };
const SYNTAXES = { color: { syntax: "<rgb()> | <hex-color>" } };
let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function writeFixture(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function writeJsdomFixture(root, stylesheet) {
	const jsdomRoot = join(root, "node_modules", "jsdom");
	writeFixture(join(jsdomRoot, "lib", "jsdom", "browser", "default-stylesheet.css"), stylesheet);
	writeFixture(
		join(jsdomRoot, "lib", "jsdom", "living", "css", "helpers", "computed-style.js"),
		`"use strict";\n\nconst fs = require("node:fs");\nconst path = require("node:path");\n\nconst defaultStyleSheet = fs.readFileSync(\n  path.resolve(__dirname, "../../../browser/default-stylesheet.css"),\n  { encoding: "utf-8" }\n);\n`,
	);
	return join(jsdomRoot, "lib", "jsdom", "living", "css", "helpers", "computed-style.js");
}

function writeJsdomXhrFixture(root) {
	const xhrRoot = join(root, "node_modules", "jsdom", "lib", "jsdom", "living", "xhr");
	writeFixture(join(xhrRoot, "xhr-sync-worker.js"), `"use strict";\n`);
	const xhrImplementationPath = join(xhrRoot, "XMLHttpRequest-impl.js");
	writeFixture(
		xhrImplementationPath,
		`"use strict";\n\nconst syncWorkerFile = require.resolve("./xhr-sync-worker.js");\n`,
	);
	return xhrImplementationPath;
}

function runPreparation(root, cwd = root, script = prepareAssetsScript) {
	return spawnSync(process.execPath, [script], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, PI_BUN_COMPILE_REPO_ROOT: root },
	});
}

// Mirrors the upstream css-tree 3.x sources byte-for-byte: every one of these modules
// resolves its data through createRequire at module scope, which is what Bun's compiled
// filesystem cannot serve.
function writeCssTreeFixture(nodeModulesRoot) {
	const cssTreeRoot = join(nodeModulesRoot, "css-tree");
	writeFixture(
		join(cssTreeRoot, "package.json"),
		`${JSON.stringify({ name: "css-tree", version: CSS_TREE_VERSION, type: "module" })}\n`,
	);
	writeFixture(join(cssTreeRoot, "data", "patch.json"), JSON.stringify(PATCH));
	writeFixture(
		join(cssTreeRoot, "lib", "data-patch.js"),
		"import { createRequire } from 'module';\n\nconst require = createRequire(import.meta.url);\nconst patch = require('../data/patch.json');\n\nexport default patch;\n",
	);
	writeFixture(
		join(cssTreeRoot, "cjs", "data-patch.cjs"),
		"'use strict';\n\nconst patch = require('../data/patch.json');\n\nconst patch$1 = patch;\n\nmodule.exports = patch$1;\n",
	);
	writeFixture(
		join(cssTreeRoot, "lib", "data.js"),
		"import { createRequire } from 'module';\nimport patch from './data-patch.js';\n\nconst require = createRequire(import.meta.url);\nconst mdnAtrules = require('mdn-data/css/at-rules.json');\nconst mdnProperties = require('mdn-data/css/properties.json');\nconst mdnSyntaxes = require('mdn-data/css/syntaxes.json');\n\nexport default { mdnAtrules, mdnProperties, mdnSyntaxes, patch };\n",
	);
	writeFixture(
		join(cssTreeRoot, "cjs", "data.cjs"),
		"'use strict';\n\nconst dataPatch = require('./data-patch.cjs');\n\nconst mdnAtrules = require('mdn-data/css/at-rules.json');\nconst mdnProperties = require('mdn-data/css/properties.json');\nconst mdnSyntaxes = require('mdn-data/css/syntaxes.json');\n\nmodule.exports = { mdnAtrules, mdnProperties, mdnSyntaxes, dataPatch };\n",
	);
	writeFixture(
		join(cssTreeRoot, "lib", "version.js"),
		"import { createRequire } from 'module';\n\nconst require = createRequire(import.meta.url);\n\nexport const { version } = require('../package.json');\n",
	);
	writeFixture(
		join(cssTreeRoot, "cjs", "version.cjs"),
		"'use strict';\n\nconst { version } = require('../package.json');\n\nexports.version = version;\n",
	);
	const mdnCssRoot = join(nodeModulesRoot, "mdn-data", "css");
	writeFixture(join(mdnCssRoot, "at-rules.json"), JSON.stringify(AT_RULES));
	writeFixture(join(mdnCssRoot, "properties.json"), JSON.stringify(PROPERTIES));
	writeFixture(join(mdnCssRoot, "syntaxes.json"), JSON.stringify(SYNTAXES));
	return cssTreeRoot;
}

function cssTreeSources(cssTreeRoot) {
	return [
		["lib", "data-patch.js"],
		["cjs", "data-patch.cjs"],
		["lib", "data.js"],
		["cjs", "data.cjs"],
		["lib", "version.js"],
		["cjs", "version.cjs"],
	].map((parts) => readFileSync(join(cssTreeRoot, ...parts), "utf8"));
}

describe("prepare-bun-compile-assets", () => {
	it("inlines jsdom's default stylesheet for Bun-compiled binaries", () => {
		// Given: jsdom loads this stylesheet through an absolute filesystem path at runtime.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bun-compile-assets-"));
		const stylesheet = "html { color: red; }\n";
		const computedStylePath = writeJsdomFixture(tempDir, stylesheet);

		// When
		const result = runPreparation(tempDir);

		// Then: the compiled module no longer requires the filesystem-only CSS asset.
		assert.equal(result.status, 0, result.stderr);
		const preparedSource = readFileSync(computedStylePath, "utf8");
		assert.match(preparedSource, /const defaultStyleSheet = "html \{ color: red; \}\\n";/);
		assert.doesNotMatch(preparedSource, /default-stylesheet\.css/);

		// And: rebuilds invoke this preparation step again without restoring node_modules.
		const repeatedResult = runPreparation(tempDir);
		assert.equal(repeatedResult.status, 0, repeatedResult.stderr);
		assert.equal(readFileSync(computedStylePath, "utf8"), preparedSource);
	});

	it("rewrites jsdom's sync worker lookup for Bun standalone binaries", () => {
		// Given: jsdom eagerly resolves the worker to the build machine's absolute checkout path.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bun-compile-assets-"));
		writeJsdomFixture(tempDir, "html { color: red; }\n");
		const xhrImplementationPath = writeJsdomXhrFixture(tempDir);

		// When
		const result = runPreparation(tempDir);

		// Then: standalone Bun uses the embedded worker while Node keeps jsdom's original lookup.
		assert.equal(result.status, 0, result.stderr);
		const preparedSource = readFileSync(xhrImplementationPath, "utf8");
		assert.match(
			preparedSource,
			/typeof Bun !== "undefined"[\s\S]*\.\.\/\.\.\/node_modules\/jsdom\/lib\/jsdom\/living\/xhr\/xhr-sync-worker\.js[\s\S]*require\.resolve\(require\("node:path"\)\.join\(__dirname, "xhr-sync-worker\.js"\)\)/,
		);
		assert.doesNotMatch(preparedSource, /import\.meta/);

		const nodeResult = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(xhrImplementationPath)})`], {
			encoding: "utf8",
		});
		assert.equal(nodeResult.status, 0, nodeResult.stderr);

		const repeatedResult = runPreparation(tempDir);
		assert.equal(repeatedResult.status, 0, repeatedResult.stderr);
		assert.equal(readFileSync(xhrImplementationPath, "utf8"), preparedSource);
	});

	it("inlines css-tree's data so a compiled binary never resolves it at runtime", async () => {
		// Given: css-tree reads patch.json, mdn-data and its own package.json through
		// createRequire, none of which Bun's compiled filesystem can serve.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-css-tree-"));
		const nodeModulesRoot = join(tempDir, "node_modules");
		const cssTreeRoot = writeCssTreeFixture(nodeModulesRoot);

		// When
		assert.equal(inlineCssTreeCompileData(nodeModulesRoot), true);

		// Then: no module reaches for a file, and the inlined values are the upstream data.
		for (const source of cssTreeSources(cssTreeRoot)) {
			assert.doesNotMatch(source, /createRequire/);
			assert.doesNotMatch(source, /require\('\.\.\/data\/patch\.json'\)/);
			assert.doesNotMatch(source, /require\('mdn-data\/css\/[a-z-]+\.json'\)/);
			assert.doesNotMatch(source, /require\('\.\.\/package\.json'\)/);
		}
		const patchModule = await import(pathToFileURL(join(cssTreeRoot, "lib", "data-patch.js")).href);
		assert.deepEqual(patchModule.default, PATCH);
		const dataModule = await import(pathToFileURL(join(cssTreeRoot, "lib", "data.js")).href);
		assert.deepEqual(dataModule.default.mdnAtrules, AT_RULES);
		assert.deepEqual(dataModule.default.mdnProperties, PROPERTIES);
		assert.deepEqual(dataModule.default.mdnSyntaxes, SYNTAXES);
		assert.deepEqual(dataModule.default.patch, PATCH);
		const versionModule = await import(pathToFileURL(join(cssTreeRoot, "lib", "version.js")).href);
		assert.equal(versionModule.version, CSS_TREE_VERSION);
	});

	it("leaves an already prepared css-tree byte-identical", () => {
		// Given: publish staging and the binary build both prepare the same installed tree.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-css-tree-repeat-"));
		const nodeModulesRoot = join(tempDir, "node_modules");
		const cssTreeRoot = writeCssTreeFixture(nodeModulesRoot);
		inlineCssTreeCompileData(nodeModulesRoot);
		const prepared = cssTreeSources(cssTreeRoot);

		// When
		assert.equal(inlineCssTreeCompileData(nodeModulesRoot), true);

		// Then
		assert.deepEqual(cssTreeSources(cssTreeRoot), prepared);
	});

	it("fails loud when css-tree's data module matches no known shape", () => {
		// Given: a css-tree upgrade that renamed the require block we inline.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-css-tree-drift-"));
		const nodeModulesRoot = join(tempDir, "node_modules");
		const cssTreeRoot = writeCssTreeFixture(nodeModulesRoot);
		writeFixture(join(cssTreeRoot, "lib", "data.js"), "export default {};\n");

		// Then: a silent skip would ship a binary that dies on the first webfetch.
		assert.throws(() => inlineCssTreeCompileData(nodeModulesRoot), /css-tree\/lib\/data\.js/);
	});

	it("reports nothing to prepare when css-tree is not installed", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-css-tree-absent-"));
		assert.equal(inlineCssTreeCompileData(join(tempDir, "node_modules")), false);
	});

	it("resolves the repository root independently of the caller's working directory", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bun-compile-assets-"));
		writeJsdomFixture(tempDir, "html { color: red; }\n");
		const xhrImplementationPath = writeJsdomXhrFixture(tempDir);
		const copiedScript = join(tempDir, "scripts", "prepare-bun-compile-assets.mjs");
		writeFixture(copiedScript, readFileSync(prepareAssetsScript, "utf8"));
		const packageCwd = join(tempDir, "packages", "coding-agent");
		mkdirSync(packageCwd, { recursive: true });

		const result = spawnSync(process.execPath, [copiedScript], {
			cwd: packageCwd,
			encoding: "utf8",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(
			readFileSync(xhrImplementationPath, "utf8"),
			/typeof Bun !== "undefined"/,
		);
	});
});
