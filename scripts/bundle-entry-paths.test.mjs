import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { bundleRequiredInputs, lazyEntryPoints } from "./bundle-entry-points.mjs";

// Static guard for senpi#4892: every module the bundle, the binaries and `build:binary` name must still exist
// in source, so a PR that deletes or renames one fails here instead of only in a full build.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

function repoPath(path) {
	return relative(repoRoot, path).split("\\").join("/");
}

// packages/<pkg>/dist/<x>.js -> packages/<pkg>/src/<x>.{ts,tsx,mts}; source paths are checked as written.
function sourceExists(entry) {
	const dist = /^(packages\/[^/]+)\/dist\/(.+)\.js$/.exec(entry);
	if (!dist) return existsSync(join(repoRoot, entry));
	return SOURCE_EXTENSIONS.some((extension) => existsSync(join(repoRoot, dist[1], "src", `${dist[2]}${extension}`)));
}

// `bun build --compile` entrypoints, written relative to packages/coding-agent.
function compileEntrypoints(text) {
	return text
		.split("\n")
		.filter((line) => line.includes("bun build --compile"))
		.flatMap((line) => line.match(/(?<=\s)\.\/(?:dist|src)\/\S+\.(?:js|ts|tsx|mts)(?=\s)/g) ?? [])
		.map((entry) => repoPath(join(codingAgentDir, entry)));
}

function collectEntrySources() {
	const distDirs = {
		codingAgentDistDir: join(codingAgentDir, "dist"),
		aiDistDir: join(repoRoot, "packages", "ai", "dist"),
	};
	const bundleScript = readFileSync(join(repoRoot, "scripts", "build-coding-agent-bundle.mjs"), "utf8");
	const binariesScript = readFileSync(join(repoRoot, "scripts", "build-binaries.sh"), "utf8");
	const buildBinary = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8")).scripts["build:binary"];
	return {
		"bundle required inputs": bundleRequiredInputs(distDirs).map(repoPath),
		"bundle lazy entry points": Object.values(lazyEntryPoints(distDirs)).map(repoPath),
		"bundle output lookups": [...bundleScript.matchAll(/"(packages\/[^"]+\/dist\/[^"]+\.js)"/g)].map((match) => match[1]),
		"build-binaries.sh compile entrypoints": compileEntrypoints(binariesScript),
		"build:binary compile entrypoints": compileEntrypoints(` ${buildBinary} `),
	};
}

describe("bundle and binary entry paths", () => {
	it("finds entries in every list it guards", () => {
		// Given / When
		const lists = collectEntrySources();

		// Then: an empty list means the parser lost track of a script, which would make the next check vacuous.
		assert.deepEqual(
			Object.entries(lists)
				.filter(([, entries]) => entries.length === 0)
				.map(([name]) => name),
			[],
		);
	});

	it("maps every listed entry to an existing source file", () => {
		// Given
		const lists = collectEntrySources();

		// When
		const dangling = Object.entries(lists).flatMap(([name, entries]) =>
			entries.filter((entry) => !sourceExists(entry)).map((entry) => `${name}: ${entry}`),
		);

		// Then
		assert.deepEqual(dangling, [], `entries without a source file:\n${dangling.join("\n")}`);
	});
});
