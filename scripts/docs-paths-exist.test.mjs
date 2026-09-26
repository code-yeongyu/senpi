import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Docs that cite source paths; a stale cite is the doc drift this test exists to stop.
const DOCS = ["packages/coding-agent/docs/computer-use.md", "packages/coding-agent/docs/tools/computer.md"];
const SOURCE_PATH = /`((?:packages|crates)\/[^`\s*{}]+)`/g;

export function citedPaths(markdown) {
	return [...markdown.matchAll(SOURCE_PATH)].map((match) => match[1].replace(/\/$/, ""));
}

describe("docs-paths-exist", () => {
	for (const doc of DOCS) {
		it(`every source path cited in ${doc} exists`, () => {
			const cited = citedPaths(readFileSync(join(repoRoot, doc), "utf8"));
			assert.notEqual(cited.length, 0, `${doc} cites no source paths`);
			assert.deepEqual(
				cited.filter((path) => !existsSync(join(repoRoot, path))),
				[],
			);
		});
	}

	it("flags a path that does not exist", () => {
		const cited = citedPaths("see `packages/desktop-nope/x.ts` and `crates/senpi-desktop-engine`");
		assert.deepEqual(
			cited.filter((path) => !existsSync(join(repoRoot, path))),
			["packages/desktop-nope/x.ts"],
		);
	});
});
