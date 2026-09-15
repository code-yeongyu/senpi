#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const [outputRootArgument] = process.argv.slice(2);
if (!outputRootArgument) {
	throw new Error("Usage: copy-codemode-sidecar.mjs <binary-output-root>");
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceRoot = join(repoRoot, "packages", "senpi-codemode");
const manifestPath = join(sourceRoot, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const targetRoot = join(
	resolve(outputRootArgument),
	"node_modules",
	"@code-yeongyu",
	"senpi-codemode",
);

if (!Array.isArray(manifest.files)) {
	throw new Error(`${manifestPath} must declare a files array`);
}

rmSync(targetRoot, { recursive: true, force: true });
mkdirSync(targetRoot, { recursive: true });
cpSync(manifestPath, join(targetRoot, "package.json"));

for (const entry of manifest.files) {
	if (typeof entry !== "string" || isAbsolute(entry)) {
		throw new Error(`Invalid codemode package file entry: ${JSON.stringify(entry)}`);
	}
	const normalizedEntry = normalize(entry);
	if (normalizedEntry === ".." || normalizedEntry.startsWith(`..${sep}`)) {
		throw new Error(`Codemode package file escapes its source root: ${entry}`);
	}
	const sourcePath = join(sourceRoot, normalizedEntry);
	if (!existsSync(sourcePath)) {
		throw new Error(`Codemode package file does not exist: ${sourcePath}`);
	}
	cpSync(sourcePath, join(targetRoot, normalizedEntry), { recursive: true });
}

// Host API/typebox imports are provided by Jiti virtual modules. The JS rewriter's
// parser is the sole external runtime dependency not supplied by the host.
const parserRoot = dirname(createRequire(manifestPath).resolve("@babel/parser/package.json"));
cpSync(parserRoot, join(targetRoot, "node_modules", "@babel", "parser"), { recursive: true });

console.log(`[copy-codemode-sidecar] copied ${manifest.files.length + 1} entries and the JS parser to ${targetRoot}`);
