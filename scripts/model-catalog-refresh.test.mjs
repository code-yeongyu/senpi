#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { changedCatalog, REFRESH_ENTRY_PREFIX, withRefreshEntry } from "./model-catalog-refresh.mjs";

const REAL_CHANGELOG = readFileSync(new URL("../packages/ai/CHANGELOG.md", import.meta.url), "utf8");

function releasedPart(changelog) {
	const lines = changelog.split("\n");
	const start = lines.findIndex((line) => line.trim() === "## [Unreleased]");
	const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	return lines.slice(next).join("\n");
}

function unreleasedPart(changelog) {
	return changelog.slice(0, changelog.length - releasedPart(changelog).length);
}

function release(changelog, version) {
	return changelog.replace("## [Unreleased]", `## [Unreleased]\n\n### Changed\n\n## [${version}] - 2026-10-09`);
}

describe("changedCatalog (senpi#2943)", () => {
	it("names providers from the files the generator writes: data/<id>.json and <id>.models.ts", () => {
		const change = changedCatalog(
			[
				" M packages/ai/src/models.generated.ts",
				" M packages/ai/src/providers/data/nvidia.json",
				" M packages/ai/src/providers/nvidia.models.ts",
				"?? packages/ai/src/providers/data/newco.json",
				"?? packages/ai/src/providers/newco.models.ts",
				" M packages/ai/src/providers/data/.manifest.json",
			].join("\n"),
		);
		assert.deepEqual(change.providers, ["newco", "nvidia"]);
		assert.equal(change.files.length, 6);
	});

	it("reports nothing when the regeneration left the catalog unchanged", () => {
		assert.deepEqual(changedCatalog(""), { providers: [], files: [] });
	});
});

describe("withRefreshEntry on the real packages/ai/CHANGELOG.md (senpi#2943)", () => {
	it("edits only the Unreleased section: every released section stays byte-identical", () => {
		const out = withRefreshEntry(REAL_CHANGELOG, ["nvidia"]);
		assert.equal(releasedPart(out), releasedPart(REAL_CHANGELOG));
		assert.match(unreleasedPart(out), /### Changed\n\n- The bundled model catalog is refreshed .*\(`nvidia`\)\.\n/);
	});

	it("replaces an earlier refresh entry in Unreleased instead of stacking a second one", () => {
		const once = withRefreshEntry(REAL_CHANGELOG, ["nvidia"]);
		const twice = withRefreshEntry(once, ["nvidia", "openrouter"]);
		assert.equal(unreleasedPart(twice).split(REFRESH_ENTRY_PREFIX).length - 1, 1);
		assert.match(unreleasedPart(twice), /\(`nvidia`, `openrouter`\)/);
		assert.equal(unreleasedPart(twice).replace(/\(`nvidia`, `openrouter`\)/, "(`nvidia`)"), unreleasedPart(once));
	});

	it("leaves a refresh entry that already shipped in a release alone", () => {
		const shipped = release(withRefreshEntry(REAL_CHANGELOG, ["nvidia"]), "2026.10.9");
		const next = withRefreshEntry(shipped, ["openrouter"]);
		assert.equal(releasedPart(next), releasedPart(shipped));
		assert.match(releasedPart(next), /\(`nvidia`\)/);
		assert.match(unreleasedPart(next), /\(`openrouter`\)/);
	});

	it("creates a Changed subsection inside Unreleased when there is none", () => {
		const input = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New.\n\n## [1] - 2026-01-01\n\n- Old.\n";
		const out = withRefreshEntry(input, ["x"]);
		assert.equal(releasedPart(out), releasedPart(input));
		assert.match(unreleasedPart(out), /### Added\n\n- New\.\n\n### Changed\n\n- The bundled model catalog .*\(`x`\)\.\n\n$/);
	});

	it("refuses a changelog without an Unreleased section", () => {
		assert.throws(() => withRefreshEntry("# Changelog\n\n## [1] - 2026-01-01\n", ["x"]), /no ## \[Unreleased\]/);
	});
});
