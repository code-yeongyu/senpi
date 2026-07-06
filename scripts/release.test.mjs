#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_UNRELEASED_SUBSECTIONS,
	buildUnreleasedBlock,
	insertUnreleasedBlock,
	resolveNextUnreleasedSubsections,
} from "./release-changelog.mjs";
import { WORKSPACE_PACKAGES } from "./release-packages.mjs";

describe("release package versioning", () => {
	it("updates the pty workspace during lockstep releases", () => {
		assert.ok(WORKSPACE_PACKAGES.includes("packages/pty/package.json"));
	});
});

describe("release changelog bookkeeping", () => {
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
