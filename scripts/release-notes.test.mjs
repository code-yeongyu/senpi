import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(scriptsDir, "release-notes.mjs");

function fixtureMonorepo(packages) {
	const root = mkdtempSync(path.join(tmpdir(), "release-notes-"));
	for (const [dir, { name, changelog }] of Object.entries(packages)) {
		mkdirSync(path.join(root, "packages", dir), { recursive: true });
		writeFileSync(path.join(root, "packages", dir, "package.json"), `${JSON.stringify({ name })}\n`);
		writeFileSync(path.join(root, "packages", dir, "CHANGELOG.md"), changelog);
	}
	return root;
}

function extract(root, args) {
	const result = spawnSync(process.execPath, [script, "extract", "--version", "2026.10.2", "--repo", "owner/repo", ...args], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

const changelogs = {
	"coding-agent": {
		name: "@code-yeongyu/senpi",
		changelog:
			"# Changelog\n\n## [Unreleased]\n\n## [2026.10.2] - 2026-10-02\n\n### Fixed\n\n- Agent fix, see [docs](docs/rpc.md)\n\n## [2026.10.1] - 2026-10-01\n\n### Fixed\n\n- Older agent fix\n",
	},
	ai: {
		name: "@earendil-works/pi-ai",
		changelog:
			"# Changelog\n\n## [2026.10.2] - 2026-10-02\n\n### Fixed\n\n- AI fix ([#1](https://github.com/owner/repo/pull/1) by [@someone](https://github.com/someone))\n",
	},
	tui: {
		name: "@earendil-works/pi-tui",
		changelog: "# Changelog\n\n## [2026.10.2] - 2026-10-02\n\n## [2026.10.1] - 2026-10-01\n\n### Fixed\n\n- Older tui fix\n",
	},
};

test("one changelog keeps the single-section output", () => {
	const root = fixtureMonorepo(changelogs);
	try {
		const notes = extract(root, ["--changelog", "packages/coding-agent/CHANGELOG.md"]);
		assert.equal(
			notes,
			"### Fixed\n\n- Agent fix, see [docs](https://github.com/owner/repo/blob/v2026.10.2/packages/coding-agent/docs/rpc.md)\n",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("several changelogs give every package's section under its published name, in order", () => {
	const root = fixtureMonorepo(changelogs);
	try {
		const notes = extract(root, [
			"--changelog",
			"packages/coding-agent/CHANGELOG.md",
			"--changelog",
			"packages/ai/CHANGELOG.md",
			"--changelog",
			"packages/tui/CHANGELOG.md",
		]);
		assert.equal(
			notes,
			[
				"## @code-yeongyu/senpi",
				"",
				"### Fixed",
				"",
				"- Agent fix, see [docs](https://github.com/owner/repo/blob/v2026.10.2/packages/coding-agent/docs/rpc.md)",
				"",
				"## @code-yeongyu/senpi-ai",
				"",
				"### Fixed",
				"",
				"- AI fix ([#1](https://github.com/owner/repo/pull/1) by [@someone](https://github.com/someone))",
				"",
			].join("\n"),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("several changelogs with no section for the version fall back to the release line", () => {
	const root = fixtureMonorepo(changelogs);
	try {
		const notes = extract(root, ["--version", "2026.9.30", "--changelog", "packages/ai/CHANGELOG.md", "--changelog", "packages/tui/CHANGELOG.md"]);
		assert.equal(notes, "Release 2026.9.30\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("--published combines every published package's section and leaves unpublished packages out", () => {
	const root = fixtureMonorepo({
		...changelogs,
		server: {
			name: "@earendil-works/pi-server",
			changelog: "# Changelog\n\n## [2026.10.2] - 2026-10-02\n\n### Fixed\n\n- Server fix\n",
		},
	});
	try {
		const notes = extract(root, ["--published"]);
		assert.equal(
			notes,
			[
				"## @code-yeongyu/senpi",
				"",
				"### Fixed",
				"",
				"- Agent fix, see [docs](https://github.com/owner/repo/blob/v2026.10.2/packages/coding-agent/docs/rpc.md)",
				"",
				"## @code-yeongyu/senpi-ai",
				"",
				"### Fixed",
				"",
				"- AI fix ([#1](https://github.com/owner/repo/pull/1) by [@someone](https://github.com/someone))",
				"",
			].join("\n"),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
