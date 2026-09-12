#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Two kinds of preparation live here, and the difference decides who may call them.
//
// PORTABLE (inlineCssTreeCompileData): css-tree resolves data/patch.json, the mdn-data
// dictionaries and its own package.json through createRequire(import.meta.url) at module
// scope. Bun's compiled filesystem serves no dynamic require, so a compiled binary dies on
// the first webfetch HTML conversion with "Cannot find module '../data/patch.json'".
// Inlining that JSON is pure data with identical semantics under Node, Bun and a compiled
// binary, so the published tarball carries it too (staged by copyPublishDependencies).
//
// BINARY-LAYOUT (patchJsdomBinaryLookups): rewriting jsdom's worker lookup hardcodes a path
// that is only correct inside our standalone binary layout. It must never reach the npm
// tarball, or a plain Bun consumer of the published package would resolve the wrong file.

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

const CJS_MDN_REQUIRES =
	"const mdnAtrules = require('mdn-data/css/at-rules.json');\nconst mdnProperties = require('mdn-data/css/properties.json');\nconst mdnSyntaxes = require('mdn-data/css/syntaxes.json');";
const ESM_MDN_REQUIRES = `const require = createRequire(import.meta.url);\n${CJS_MDN_REQUIRES}`;
const MDN_INLINED_MARKER = "const mdnAtrules = {";
const ESM_CREATE_REQUIRE_IMPORT = "import { createRequire } from 'module';\n";
const jsdomDefaultStylesheetRead =
	/const defaultStyleSheet = fs\.readFileSync\(\s*path\.resolve\(\s*__dirname,\s*["']\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css["']\s*\),\s*(?:\{\s*encoding:\s*["']utf-8["']\s*\}|["']utf8["'])\s*\);/;
const jsdomSyncWorkerResolve =
	/const syncWorkerFile = require\.resolve\(\s*["']\.\/xhr-sync-worker\.js["']\s*\);/;

function serializeJsonFile(path) {
	return JSON.stringify(JSON.parse(readFileSync(path, "utf8")), null, "\t");
}

function writeIfChanged(path, contents) {
	if (!existsSync(path)) {
		return;
	}
	if (readFileSync(path, "utf8") === contents) {
		return;
	}
	writeFileSync(path, contents);
}

// Inlining the data leaves css-tree's createRequire import unused; a shipped artifact should
// carry no dead resolver, so it goes once nothing calls it.
function dropUnusedCreateRequireImport(path) {
	if (!existsSync(path)) {
		return;
	}
	const source = readFileSync(path, "utf8");
	if (source.includes("createRequire(") || !source.includes(ESM_CREATE_REQUIRE_IMPORT)) {
		return;
	}
	writeFileSync(path, source.replace(ESM_CREATE_REQUIRE_IMPORT, ""));
}

// A file matching neither the upstream shape nor the already-inlined one is dependency
// drift: failing here beats shipping an artifact that only breaks once a user fetches a page.
function inlineOnce(path, pattern, replacement, inlinedMarker, relativeName) {
	if (!existsSync(path)) {
		return;
	}
	const source = readFileSync(path, "utf8");
	const inlined = source.replace(pattern, () => replacement);
	if (inlined !== source) {
		writeFileSync(path, inlined);
		return;
	}
	if (!source.includes(inlinedMarker)) {
		throw new Error(`Unable to inline ${relativeName}`);
	}
}

export function inlineCssTreeCompileData(nodeModulesRoot) {
	const cssTreeRoot = join(nodeModulesRoot, "css-tree");
	const patchJsonPath = join(cssTreeRoot, "data", "patch.json");
	if (!existsSync(patchJsonPath)) {
		return false;
	}

	const patch = `${serializeJsonFile(patchJsonPath)}\n`;
	writeIfChanged(join(cssTreeRoot, "lib", "data-patch.js"), `const patch = ${patch}\nexport default patch;\n`);
	writeIfChanged(join(cssTreeRoot, "cjs", "data-patch.cjs"), `'use strict';\n\nmodule.exports = ${patch}`);

	const mdnCssRoot = join(nodeModulesRoot, "mdn-data", "css");
	if (existsSync(join(mdnCssRoot, "at-rules.json"))) {
		const dataConstants = [
			`const mdnAtrules = ${serializeJsonFile(join(mdnCssRoot, "at-rules.json"))};`,
			`const mdnProperties = ${serializeJsonFile(join(mdnCssRoot, "properties.json"))};`,
			`const mdnSyntaxes = ${serializeJsonFile(join(mdnCssRoot, "syntaxes.json"))};`,
		].join("\n");
		inlineOnce(
			join(cssTreeRoot, "lib", "data.js"),
			ESM_MDN_REQUIRES,
			dataConstants,
			MDN_INLINED_MARKER,
			"css-tree/lib/data.js",
		);
		inlineOnce(
			join(cssTreeRoot, "cjs", "data.cjs"),
			CJS_MDN_REQUIRES,
			dataConstants,
			MDN_INLINED_MARKER,
			"css-tree/cjs/data.cjs",
		);
		dropUnusedCreateRequireImport(join(cssTreeRoot, "lib", "data.js"));
	}

	const packageJsonPath = join(cssTreeRoot, "package.json");
	if (existsSync(packageJsonPath)) {
		const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		writeIfChanged(join(cssTreeRoot, "lib", "version.js"), `export const version = ${JSON.stringify(version)};\n`);
		writeIfChanged(
			join(cssTreeRoot, "cjs", "version.cjs"),
			`'use strict';\n\nmodule.exports.version = ${JSON.stringify(version)};\n`,
		);
	}

	return true;
}

export function patchJsdomBinaryLookups(nodeModulesRoot) {
	const jsdomRoot = join(nodeModulesRoot, "jsdom");
	const stylesheetPath = join(jsdomRoot, "lib", "jsdom", "browser", "default-stylesheet.css");
	const computedStylePath = join(jsdomRoot, "lib", "jsdom", "living", "css", "helpers", "computed-style.js");
	const xhrRoot = join(jsdomRoot, "lib", "jsdom", "living", "xhr");
	const xhrImplementationPath = join(xhrRoot, "XMLHttpRequest-impl.js");
	const xhrSyncWorkerPath = join(xhrRoot, "xhr-sync-worker.js");
	let prepared = false;

	if (existsSync(stylesheetPath) && existsSync(computedStylePath)) {
		const stylesheet = readFileSync(stylesheetPath, "utf8");
		const computedStyleSource = readFileSync(computedStylePath, "utf8");
		const inlinedStylesheet = `const defaultStyleSheet = ${JSON.stringify(stylesheet)};`;
		const preparedComputedStyleSource = computedStyleSource.replace(jsdomDefaultStylesheetRead, inlinedStylesheet);
		if (preparedComputedStyleSource === computedStyleSource) {
			if (!computedStyleSource.includes(inlinedStylesheet)) {
				throw new Error(`Unable to inline jsdom default stylesheet in ${computedStylePath}`);
			}
		} else {
			writeFileSync(computedStylePath, preparedComputedStyleSource);
		}
		prepared = true;
	}

	if (existsSync(xhrImplementationPath) && existsSync(xhrSyncWorkerPath)) {
		const xhrImplementationSource = readFileSync(xhrImplementationPath, "utf8");
		const workerLookup = `const syncWorkerFile =
  typeof Bun !== "undefined"
    ? "../../node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js"
    : require.resolve(require("node:path").join(__dirname, "xhr-sync-worker.js"));`;
		const preparedXhrImplementationSource = xhrImplementationSource.replace(jsdomSyncWorkerResolve, workerLookup);
		if (preparedXhrImplementationSource === xhrImplementationSource) {
			if (!xhrImplementationSource.includes(workerLookup)) {
				throw new Error(`Unable to rewrite jsdom sync worker lookup in ${xhrImplementationPath}`);
			}
		} else {
			writeFileSync(xhrImplementationPath, preparedXhrImplementationSource);
		}
		prepared = true;
	}

	return prepared;
}

export function stageImageGenSkill(repoRoot) {
	const sourcePath = join(
		repoRoot,
		"packages/coding-agent/src/core/extensions/builtin/imagegen/skill/SKILL.md",
	);
	if (!existsSync(sourcePath)) {
		return false;
	}
	const destinationPath = join(
		repoRoot,
		"packages/coding-agent/dist/core/extensions/builtin/imagegen/skill/SKILL.md",
	);
	mkdirSync(dirname(destinationPath), { recursive: true });
	copyFileSync(sourcePath, destinationPath);
	return true;
}

function main() {
	const repoRoot = resolve(process.env.PI_BUN_COMPILE_REPO_ROOT ?? join(scriptDirectory, ".."));
	const nodeModulesRoots = [join(repoRoot, "node_modules"), join(repoRoot, "packages", "coding-agent", "node_modules")];

	let preparedCssTreeCount = 0;
	let preparedJsdomCount = 0;
	for (const nodeModulesRoot of nodeModulesRoots) {
		if (inlineCssTreeCompileData(nodeModulesRoot)) {
			preparedCssTreeCount += 1;
		}
		if (patchJsdomBinaryLookups(nodeModulesRoot)) {
			preparedJsdomCount += 1;
		}
	}
	const preparedImageGenSkillCount = stageImageGenSkill(repoRoot) ? 1 : 0;

	if (preparedCssTreeCount === 0 && preparedJsdomCount === 0 && preparedImageGenSkillCount === 0) {
		console.log("[prepare-bun-compile-assets] css-tree, jsdom, and imagegen assets not installed; skipping");
		return;
	}

	console.log(
		`[prepare-bun-compile-assets] prepared Bun compile assets (${preparedCssTreeCount} css-tree, ${preparedJsdomCount} jsdom, ${preparedImageGenSkillCount} imagegen skill)`,
	);
}

// macOS TMPDIR is a symlink (/var/folders -> /private/var/folders), so the entry check
// compares real paths: argv[1] keeps the symlinked spelling while import.meta.url does not.
function realPathOrSelf(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

if (process.argv[1] && realPathOrSelf(fileURLToPath(import.meta.url)) === realPathOrSelf(resolve(process.argv[1]))) {
	main();
}
