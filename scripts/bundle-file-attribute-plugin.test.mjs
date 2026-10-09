#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { build } from "esbuild";
import { fileAttributePlugin } from "./bundle-file-attribute-plugin.mjs";

// The release bundle's `bin` file runs on Node for npm installs and on Bun for `bun install -g`.
const runtimes = ["node", "bun"];
const assetSource = "# fixture skill\n\nbytes the bundle must ship unchanged\n";
// Mirrors a consumer that checks the embedded path with existsSync, as the imagegen skill does.
const lazySource = `import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
export async function describeAsset() {
	const path = (await import("./skill/SKILL.md", { with: { type: "file" } })).default;
	const exists = existsSync(path);
	return { path, absolute: isAbsolute(path), exists, content: exists ? readFileSync(path, "utf8") : undefined };
}
`;
const entrySource = `const { describeAsset } = await import("./lazy.mjs");
console.log(JSON.stringify(await describeAsset()));
`;

let tempDir;
afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

function writeFixture(root) {
	const source = join(root, "src");
	mkdirSync(join(source, "skill"), { recursive: true });
	writeFileSync(join(source, "skill", "SKILL.md"), assetSource);
	writeFileSync(join(source, "lazy.mjs"), lazySource);
	writeFileSync(join(source, "entry.mjs"), entrySource);
	return source;
}

// Both shapes the release build uses: the split main bundle (entries at the root, chunks one
// level down) and the unsplit sibling build emitted straight into the chunks directory.
const layouts = [
	{ name: "split main bundle", outdir: "bundle", options: { splitting: true, chunkNames: "chunks/[name]-[hash]" } },
	{ name: "unsplit sibling build", outdir: join("bundle", "chunks"), options: { splitting: false } },
];

describe("bundled file-attribute imports", () => {
	for (const layout of layouts) {
		for (const runtime of runtimes) {
			it(`resolve to the shipped asset from a foreign cwd (${layout.name}, ${runtime})`, async () => {
				// Given: a bundle built through the release plugin and a cwd unrelated to it.
				tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-file-attribute-"));
				const source = writeFixture(tempDir);
				const outdir = join(tempDir, layout.outdir);
				await build({
					bundle: true,
					entryNames: "[name]",
					entryPoints: { entry: join(source, "entry.mjs") },
					format: "esm",
					logLevel: "silent",
					outdir,
					platform: "node",
					plugins: [fileAttributePlugin],
					...layout.options,
				});
				const foreignCwd = join(tempDir, "elsewhere");
				mkdirSync(foreignCwd);
				// When
				const result = spawnSync(runtime, [join(outdir, "entry.js")], { cwd: foreignCwd, encoding: "utf8" });
				// Then: the same contract Bun's native file import gives, independent of cwd.
				assert.equal(result.status, 0, result.stderr);
				const described = JSON.parse(result.stdout);
				assert.equal(described.absolute, true, `embedded path ${described.path} is not absolute`);
				assert.equal(described.exists, true, `embedded path ${described.path} does not exist`);
				assert.equal(described.content, readFileSync(join(source, "skill", "SKILL.md"), "utf8"));
			});
		}
	}
});
