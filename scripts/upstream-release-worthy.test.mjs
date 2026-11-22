import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CHANGELOGS } from "./release-changelog.mjs";
import { decideReleaseWorthiness, extractUnreleasedSection, hasUnreleasedEntries } from "./upstream-release-worthy.mjs";

describe("upstream release worthiness", () => {
	it("counts pending changelog fragments without writing the compiled preview (senpi#3767)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "senpi-worthy-fragments-"));
		const log = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n";
		try {
			for (const path of CHANGELOGS) {
				mkdirSync(dirname(join(cwd, path)), { recursive: true });
				writeFileSync(join(cwd, path), log);
			}
			const script = fileURLToPath(new URL("./upstream-release-worthy.mjs", import.meta.url));
			const run = () => execFileSync(process.execPath, [script], { cwd, encoding: "utf8", timeout: 30_000 });
			assert.match(run(), /release_worthy=false/);
			mkdirSync(join(cwd, "changes/unreleased"), { recursive: true });
			for (const target of new Set(["packages/server/CHANGELOG.md", ...CHANGELOGS])) {
				const fragment = `<!-- changes-log: ${target} -->\n### Fixed\n- Pending fix\n`;
				writeFileSync(join(cwd, "changes/unreleased/21.md"), fragment);
				assert.match(run(), /release_worthy=true/, target);
				for (const path of CHANGELOGS) assert.equal(readFileSync(join(cwd, path), "utf8"), log);
				assert.equal(readFileSync(join(cwd, "changes/unreleased/21.md"), "utf8"), fragment);
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("detects package changelog entries under Unreleased", () => {
		const text = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixed upstream sync.\n\n## [2026.6.17]\n\n";
		assert.equal(hasUnreleasedEntries(text), true);
		assert.equal(extractUnreleasedSection(text).includes("Fixed upstream sync"), true);
	});

	it("skips empty Unreleased sections", () => {
		const files = [
			{ path: "packages/coding-agent/CHANGELOG.md", content: "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n" },
		];
		assert.deepEqual(decideReleaseWorthiness(files), {
			releaseWorthy: false,
			reason: "no-unreleased-package-entries",
		});
	});

	it("releases when any package changelog has an Unreleased entry", () => {
		const files = [
			{ path: "packages/ai/CHANGELOG.md", content: "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n" },
			{
				path: "packages/tui/CHANGELOG.md",
				content: "# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- Updated rendering.\n",
			},
		];
		assert.equal(decideReleaseWorthiness(files).releaseWorthy, true);
	});

	it("allows explicit forced release", () => {
		const files = [{ path: "packages/coding-agent/CHANGELOG.md", content: "# Changelog\n\n## [Unreleased]\n\n" }];
		assert.deepEqual(decideReleaseWorthiness(files, { forceRelease: true }), {
			releaseWorthy: true,
			reason: "forced",
		});
	});
});
