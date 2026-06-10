#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const workspaceRoot = resolve(packageDir, "..", "..");
const defaultSourceRoot = resolve(workspaceRoot, "..", "pi-extensions");
const sourceRoot = resolve(process.env.SENPI_BUILTIN_EXTENSIONS_SOURCE ?? defaultSourceRoot);
const builtinRoot = join(packageDir, "src", "core", "extensions", "builtin");

const FILES = [
	{
		source: "pi-bash-timeout/src/index.ts",
		target: "bash-timeout/index.ts",
		transform: (content) =>
			content.replace(
				'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";',
				'import type { ExtensionAPI } from "../../types.js";',
			),
	},
	{ source: "pi-bash-timeout/src/timeout.ts", target: "bash-timeout/timeout.ts" },
	// pi-apply-patch has diverged: senpi maintains a refactored multi-file version under
	// gpt-apply-patch/ (apply.ts, constants.ts, errors.ts, extension.ts, parser.ts, tool.ts, ...)
	// while pi-apply-patch upstream is still a single src/index.ts monolith. Re-enabling the old
	// monolithic sync would overwrite senpi's barrel index.ts and lose the refactor. Port
	// behavior changes manually until the upstream package is restructured to match.
	//
	// pi-todotools has also diverged: senpi removed the todo continuation feature, so every
	// vendored file under todotools/ differs from upstream (which still ships guards.ts and the
	// continuation runtime). Regular file-copy sync would reintroduce the removed feature and
	// overwrite senpi's changes. Port improvements manually.
];

// PACKAGES records upstream package versions in external-versions.json even when the FILES sync
// is intentionally skipped for a package, so downstream consumers (and the
// builtin-extension-sync test) still see the source-of-truth metadata for every vendored
// builtin without us auto-overwriting the diverged files above.
const PACKAGES = [
	{ id: "bash-timeout", packageDir: "pi-bash-timeout" },
	{ id: "gpt-apply-patch", packageDir: "pi-apply-patch" },
	{ id: "todowrite", packageDir: "pi-todotools" },
];

function readPackageMetadata(packageName) {
	const packageJsonPath = join(sourceRoot, packageName, "package.json");
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	return {
		packageName: packageJson.name,
		version: packageJson.version,
		source: `../pi-extensions/${packageName}`,
	};
}

if (!existsSync(sourceRoot)) {
	console.log(`[sync-builtin-extensions] source not found, keeping vendored snapshot: ${sourceRoot}`);
	process.exit(0);
}

for (const entry of FILES) {
	const sourcePath = join(sourceRoot, entry.source);
	const targetPath = join(builtinRoot, entry.target);
	if (!existsSync(sourcePath)) {
		throw new Error(`missing source file: ${sourcePath}`);
	}
	mkdirSync(dirname(targetPath), { recursive: true });
	const content = readFileSync(sourcePath, "utf-8");
	writeFileSync(targetPath, entry.transform ? entry.transform(content) : content, "utf-8");
}

const manifest = { extensions: {} };
for (const packageEntry of PACKAGES) {
	manifest.extensions[packageEntry.id] = readPackageMetadata(packageEntry.packageDir);
}
writeFileSync(join(builtinRoot, "external-versions.json"), `${JSON.stringify(manifest, null, "\t")}\n`, "utf-8");

console.log(`[sync-builtin-extensions] synced from ${sourceRoot}`);
