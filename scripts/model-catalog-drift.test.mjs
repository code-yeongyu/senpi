#!/usr/bin/env node
// The refresh workflows' drift reading (senpi#2943, senpi#2287): a regeneration that only re-stamped the manifest is no
// change, and every changed generator file is named. Contract of the refresh PR pipeline.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	CATALOG_MANIFEST,
	changedCatalogPaths,
	discardTimestampOnlyCatalogChange,
	isTimestampOnlyManifestChange,
} from "./model-catalog-drift.mjs";

const manifest = (generatedAt, hash) =>
	`${JSON.stringify({ schemaVersion: 6, generatedAt, structureHash: "s", files: { "nvidia.json": hash } })}\n`;

describe("isTimestampOnlyManifestChange (senpi#2943)", () => {
	it("is true when only generatedAt moved", () => {
		assert.equal(isTimestampOnlyManifestChange(manifest("2026-10-01T00:00:00Z", "h1"), manifest("2026-10-08T00:00:00Z", "h1")), true);
	});

	it("is false when a file hash changed", () => {
		assert.equal(isTimestampOnlyManifestChange(manifest("2026-10-01T00:00:00Z", "h1"), manifest("2026-10-08T00:00:00Z", "h2")), false);
	});
});

describe("catalog drift after a regeneration (senpi#2645)", () => {
	const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
	function repoWithCatalog() {
		const root = mkdtempSync(join(tmpdir(), "senpi-release-gate-"));
		git(root, "init", "-q");
		git(root, "config", "user.email", "gate@example.invalid");
		git(root, "config", "user.name", "gate");
		mkdirSync(join(root, "packages/ai/src/providers/data"), { recursive: true });
		writeFileSync(join(root, "packages/ai/src/models.generated.ts"), "export const MODELS = {};\n");
		writeFileSync(join(root, "packages/ai/src/providers/data/nvidia.json"), '{"a":1}\n');
		writeFileSync(join(root, CATALOG_MANIFEST), manifest("2026-10-01T00:00:00.000Z", "h1"));
		writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "base");
		return root;
	}

	it("is false when the regeneration left every catalog file as HEAD has it", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [1.0.0]\n");
			assert.equal(changedCatalogPaths(root).length > 0, false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("is true when the regeneration rewrote a provider's catalog data", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, "packages/ai/src/providers/data/nvidia.json"), '{"b":2}\n');
			assert.equal(changedCatalogPaths(root).length > 0, true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("is true when the regeneration added a new provider's catalog file", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, "packages/ai/src/providers/data/newprovider.json"), '{"c":3}\n');
			assert.equal(changedCatalogPaths(root).length > 0, true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats a regeneration that only re-stamped the manifest as unchanged, and restores HEAD's manifest", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, CATALOG_MANIFEST), manifest("2026-10-08T09:00:00.000Z", "h1"));
			assert.equal(discardTimestampOnlyCatalogChange(root), true);
			assert.equal(changedCatalogPaths(root).length > 0, false);
			assert.equal(readFileSync(join(root, CATALOG_MANIFEST), "utf8"), manifest("2026-10-01T00:00:00.000Z", "h1"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a manifest change that came with real catalog drift", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, "packages/ai/src/providers/data/nvidia.json"), '{"b":2}\n');
			writeFileSync(join(root, CATALOG_MANIFEST), manifest("2026-10-08T09:00:00.000Z", "h2"));
			assert.equal(discardTimestampOnlyCatalogChange(root), false);
			assert.equal(changedCatalogPaths(root).length > 0, true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a manifest-only change that is more than the stamp", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, CATALOG_MANIFEST), manifest("2026-10-08T09:00:00.000Z", "h9"));
			assert.equal(discardTimestampOnlyCatalogChange(root), false);
			assert.equal(changedCatalogPaths(root).length > 0, true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// senpi#6645 review (32e83a5610, finding 4): changedCatalogPaths reads `git status --porcelain -z`, so a path git
// would quote (spaces, special characters) and a rename come back as real, stageable paths.
describe("changedCatalogPaths (senpi#6645)", () => {
	it("returns paths with spaces unquoted, and a staged rename by its destination, all stageable", () => {
		const dir = mkdtempSync(join(tmpdir(), "catalog-paths-"));
		const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
		try {
			git("init", "-q", "-b", "main");
			const data = join(dir, "packages/ai/src/providers/data");
			mkdirSync(data, { recursive: true });
			writeFileSync(join(data, "old name.json"), "{\"provider\":\"renamed\",\"models\":[1,2,3]}\n");
			writeFileSync(join(data, "kept.json"), "{\"provider\":\"kept\"}\n");
			git("add", "-A");
			git("-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
			git("mv", "packages/ai/src/providers/data/old name.json", "packages/ai/src/providers/data/new name.json");
			writeFileSync(join(data, "kept.json"), "{\"changed\":true}\n");
			writeFileSync(join(data, "brand new.json"), "[]\n");
			assert.deepEqual([...changedCatalogPaths(dir)].sort(), [
				"packages/ai/src/providers/data/brand new.json",
				"packages/ai/src/providers/data/kept.json",
				"packages/ai/src/providers/data/new name.json",
			]);
			git("add", "-A", "--", ...changedCatalogPaths(dir));
			assert.match(git("diff", "--cached", "--name-status"), /^R\d*\tpackages\/ai\/src\/providers\/data\/old name\.json\tpackages\/ai\/src\/providers\/data\/new name\.json$/m);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
