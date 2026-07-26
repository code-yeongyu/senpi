#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const cssTreeRoots = [
	join(repoRoot, "node_modules", "css-tree"),
	join(repoRoot, "packages", "coding-agent", "node_modules", "css-tree"),
];
const jsdomRoots = [
	join(repoRoot, "node_modules", "jsdom"),
	join(repoRoot, "packages", "coding-agent", "node_modules", "jsdom"),
];
const jsdomDefaultStylesheetRead =
	/const defaultStyleSheet = fs\.readFileSync\(\s*path\.resolve\(\s*__dirname,\s*["']\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css["']\s*\),\s*(?:\{\s*encoding:\s*["']utf-8["']\s*\}|["']utf8["'])\s*\);/;

let preparedCssTreeCount = 0;
let preparedJsdomCount = 0;

for (const cssTreeRoot of cssTreeRoots) {
	const patchJsonPath = join(cssTreeRoot, "data", "patch.json");
	const packageJsonPath = join(cssTreeRoot, "package.json");
	const mdnCssRoot = join(cssTreeRoot, "..", "mdn-data", "css");
	const cjsDataPath = join(cssTreeRoot, "cjs", "data.cjs");
	const cjsPatchPath = join(cssTreeRoot, "cjs", "data-patch.cjs");
	const cjsVersionPath = join(cssTreeRoot, "cjs", "version.cjs");
	const esmDataPath = join(cssTreeRoot, "lib", "data.js");
	const esmPatchPath = join(cssTreeRoot, "lib", "data-patch.js");
	const esmVersionPath = join(cssTreeRoot, "lib", "version.js");

	if (!existsSync(patchJsonPath)) {
		continue;
	}

	const patchData = JSON.parse(readFileSync(patchJsonPath, "utf8"));
	const serializedPatch = `${JSON.stringify(patchData, null, "\t")}\n`;

	if (existsSync(cjsPatchPath)) {
		writeFileSync(cjsPatchPath, `'use strict';\n\nmodule.exports = ${serializedPatch}`);
	}

	if (existsSync(esmPatchPath)) {
		writeFileSync(esmPatchPath, `const patch = ${serializedPatch}\nexport default patch;\n`);
	}

	const mdnAtrulesPath = join(mdnCssRoot, "at-rules.json");
	const mdnPropertiesPath = join(mdnCssRoot, "properties.json");
	const mdnSyntaxesPath = join(mdnCssRoot, "syntaxes.json");
	if (existsSync(mdnAtrulesPath) && existsSync(mdnPropertiesPath) && existsSync(mdnSyntaxesPath)) {
		const dataConstants = [
			`const mdnAtrules = ${JSON.stringify(JSON.parse(readFileSync(mdnAtrulesPath, "utf8")), null, "\t")};`,
			`const mdnProperties = ${JSON.stringify(JSON.parse(readFileSync(mdnPropertiesPath, "utf8")), null, "\t")};`,
			`const mdnSyntaxes = ${JSON.stringify(JSON.parse(readFileSync(mdnSyntaxesPath, "utf8")), null, "\t")};`,
		].join("\n");

		if (existsSync(cjsDataPath)) {
			const dataSource = readFileSync(cjsDataPath, "utf8");
			writeFileSync(
				cjsDataPath,
				dataSource.replace(
					/const mdnAtrules = require\('mdn-data\/css\/at-rules\.json'\);\nconst mdnProperties = require\('mdn-data\/css\/properties\.json'\);\nconst mdnSyntaxes = require\('mdn-data\/css\/syntaxes\.json'\);/,
					() => dataConstants,
				),
			);
		}

		if (existsSync(esmDataPath)) {
			const dataSource = readFileSync(esmDataPath, "utf8");
			writeFileSync(
				esmDataPath,
				dataSource.replace(
					/const require = createRequire\(import\.meta\.url\);\nconst mdnAtrules = require\('mdn-data\/css\/at-rules\.json'\);\nconst mdnProperties = require\('mdn-data\/css\/properties\.json'\);\nconst mdnSyntaxes = require\('mdn-data\/css\/syntaxes\.json'\);/,
					() => dataConstants,
				),
			);
		}
	}

	if (existsSync(packageJsonPath)) {
		const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (existsSync(cjsVersionPath)) {
			writeFileSync(cjsVersionPath, `'use strict';\n\nmodule.exports.version = ${JSON.stringify(version)};\n`);
		}
		if (existsSync(esmVersionPath)) {
			writeFileSync(esmVersionPath, `export const version = ${JSON.stringify(version)};\n`);
		}
	}

	preparedCssTreeCount += 1;
}

for (const jsdomRoot of jsdomRoots) {
	const stylesheetPath = join(jsdomRoot, "lib", "jsdom", "browser", "default-stylesheet.css");
	const computedStylePath = join(jsdomRoot, "lib", "jsdom", "living", "css", "helpers", "computed-style.js");
	if (!existsSync(stylesheetPath) || !existsSync(computedStylePath)) {
		continue;
	}

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

	preparedJsdomCount += 1;
}

if (preparedCssTreeCount === 0 && preparedJsdomCount === 0) {
	console.log("[prepare-bun-compile-assets] css-tree and jsdom assets not installed; skipping");
	process.exit(0);
}

console.log(
	`[prepare-bun-compile-assets] prepared Bun compile assets (${preparedCssTreeCount} css-tree, ${preparedJsdomCount} jsdom)`,
);
