import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changelogAfterPinnedRelease } from "./release-pinned-changelog.mjs";

describe("changelogAfterPinnedRelease", () => {
	const old = "## [1.0.0] - 2026-01-01\n\n- old\n";

	it("splits main's [Unreleased] into what the pinned release shipped and what came later", () => {
		const main = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A\n- B\n\n${old}`;
		const pinned = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A\n\n${old}`;
		const released = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n## [1.1.0] - 2026-02-01\n\n### Fixed\n\n- A\n\n${old}`;
		assert.equal(
			changelogAfterPinnedRelease({ main, pinned, released, version: "1.1.0" }),
			`# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- B\n\n## [1.1.0] - 2026-02-01\n\n### Fixed\n\n- A\n\n${old}`,
		);
	});

	it("removes one shipped copy per pinned entry, so a later duplicate line stays unreleased", () => {
		const main = `## [Unreleased]\n\n- same\n- same\n\n${old}`;
		const pinned = `## [Unreleased]\n\n- same\n\n${old}`;
		const released = `## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n- same\n\n${old}`;
		const next = changelogAfterPinnedRelease({ main, pinned, released, version: "1.1.0" }) ?? "";
		assert.equal(next.slice(0, next.indexOf("## [1.1.0]")).match(/- same/g)?.length, 1);
	});

	it("returns null when main has no [Unreleased] or the tag has no section for the version", () => {
		assert.equal(changelogAfterPinnedRelease({ main: old, pinned: old, released: old, version: "1.1.0" }), null);
		assert.equal(changelogAfterPinnedRelease({ main: `## [Unreleased]\n\n${old}`, pinned: "", released: old, version: "1.1.0" }), null);
	});
});
