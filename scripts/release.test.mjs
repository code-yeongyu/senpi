#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	CHANGELOGS,
	DEFAULT_UNRELEASED_SUBSECTIONS,
	buildUnreleasedBlock,
	insertUnreleasedBlock,
	resolveNextUnreleasedSubsections,
} from "./release-changelog.mjs";
import { applyWorkspaceVersions } from "./release-packages.mjs";

let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("release package versioning", () => {
	it("updates the pty workspace during lockstep releases", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-release-versioning-"));
		for (const file of [
			"packages/ai/package.json",
			"packages/agent/package.json",
			"packages/coding-agent/package.json",
			"packages/server/package.json",
			"packages/storage/sqlite-node/package.json",
			"packages/pty/package.json",
			"packages/senpi-codemode/package.json",
			"packages/tui/package.json",
			"packages/web-ui/package.json",
		]) {
			writeJson(join(tempDir, file), { name: file, version: "0.0.0" });
		}
		const previousCwd = process.cwd();
		const logs = [];

		try {
			// When
			process.chdir(tempDir);
			applyWorkspaceVersions("2099.1.2", false, (message) => logs.push(message), assert.fail);
		} finally {
			process.chdir(previousCwd);
		}

		// Then
		const ptyPackage = JSON.parse(
			readFileSync(join(tempDir, "packages", "pty", "package.json"), "utf8"),
		);
		assert.equal(ptyPackage.version, "2099.1.2");
		assert.ok(logs.includes("  packages/pty/package.json: 0.0.0 -> 2099.1.2"));
	});
});

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, undefined, "\t")}\n`);
}

describe("release changelog bookkeeping", () => {
	it("stamps the bundled codemode changelog during lockstep releases", () => {
		// Given
		const codemodeChangelog = "packages/senpi-codemode/CHANGELOG.md";

		// When
		const isIncluded = CHANGELOGS.includes(codemodeChangelog);

		// Then
		assert.equal(isIncluded, true);
	});

	it("recreates the standard next-cycle section when no previous Unreleased block was captured", () => {
		// Given
		const capturedSubsections = undefined;

		// When
		const subsections = resolveNextUnreleasedSubsections(capturedSubsections);
		const block = buildUnreleasedBlock(subsections);

		// Then
		assert.deepEqual(subsections, DEFAULT_UNRELEASED_SUBSECTIONS);
		assert.equal(
			block,
			[
				"## [Unreleased]",
				"",
				"### Breaking Changes",
				"",
				"### Added",
				"",
				"### Changed",
				"",
				"### Fixed",
				"",
				"### Removed",
				"",
				"",
			].join("\n"),
		);
	});

	it("preserves captured subsection shape when a previous Unreleased block existed", () => {
		// Given
		const capturedSubsections = ["### Fixed"];

		// When
		const subsections = resolveNextUnreleasedSubsections(capturedSubsections);

		// Then
		assert.deepEqual(subsections, ["### Fixed"]);
	});

	it("inserts the next-cycle section before the stamped release header", () => {
		// Given
		const block = buildUnreleasedBlock(["### Fixed"]);
		const changelog = "# Changelog\n\n## [2026.5.20-4] - 2026-05-20\n\n### Fixed\n\n- Fixed bug.\n";

		// When
		const updated = insertUnreleasedBlock(changelog, "2026.5.20-4", "2026-05-20", block);

		// Then
		assert.equal(
			updated,
			"# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n## [2026.5.20-4] - 2026-05-20\n\n### Fixed\n\n- Fixed bug.\n",
		);
	});

	it("restores the next-cycle section after the title when no release header was stamped", () => {
		// Given
		const block = buildUnreleasedBlock(DEFAULT_UNRELEASED_SUBSECTIONS);
		const changelog = "# Changelog\n\n## [2026.5.20] - 2026-05-20\n\n### Fixed\n\n- Fixed bug.\n";

		// When
		const updated = insertUnreleasedBlock(changelog, "2026.5.20-4", "2026-05-20", block);

		// Then
		assert.equal(
			updated,
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"### Breaking Changes",
				"",
				"### Added",
				"",
				"### Changed",
				"",
				"### Fixed",
				"",
				"### Removed",
				"",
				"## [2026.5.20] - 2026-05-20",
				"",
				"### Fixed",
				"",
				"- Fixed bug.",
				"",
			].join("\n"),
		);
	});
});
