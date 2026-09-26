#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkPrChangelog } from "./check-pr-changelog.mjs";
import { CHANGELOGS, reAddUnreleasedSections, stampChangelogs } from "./release-changelog.mjs";

describe("check-pr-changelog gate", () => {
	it("fails when runtime package source changes without a changelog entry", () => {
		// Given
		const changedFiles = ["packages/ai/src/index.ts"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, false);
		assert.deepEqual(result.runtimeFiles, ["packages/ai/src/index.ts"]);
	});

	it("passes when runtime source changes include a CHANGELOG.md edit", () => {
		// Given
		const changedFiles = ["packages/tui/src/components/app.ts", "packages/tui/CHANGELOG.md"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});

	it("passes when runtime source changes carry the no-changelog label", () => {
		// Given
		const changedFiles = ["packages/agent/src/run.ts"];
		const labels = ["bug", "no-changelog"];

		// When
		const result = checkPrChangelog({ changedFiles, labels });

		// Then
		assert.equal(result.pass, true);
	});

	it("passes when only test files change", () => {
		// Given
		const changedFiles = [
			"packages/coding-agent/src/cli.test.ts",
			"packages/ai/src/__tests__/models.test.ts",
		];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});

	it("passes when only docs change", () => {
		// Given
		const changedFiles = ["packages/ai/README.md", "docs/guide.md", "packages/tui/src/notes.md"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});

	it("passes when only workflows change", () => {
		// Given
		const changedFiles = [".github/workflows/ci.yml"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});

	it("fails when runtime source and tests change together without a changelog entry", () => {
		// Given
		const changedFiles = ["packages/pty/src/index.ts", "packages/pty/src/index.test.ts"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, false);
		assert.deepEqual(result.runtimeFiles, ["packages/pty/src/index.ts"]);
	});

	it("fails when crates/senpi-pty changes without a changelog entry", () => {
		// Given
		const changedFiles = ["crates/senpi-pty/src/lib.rs"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, false);
		assert.deepEqual(result.runtimeFiles, ["crates/senpi-pty/src/lib.rs"]);
	});

	it("fails when a crates/senpi-desktop-* crate changes without a changelog entry", () => {
		// Given
		const changedFiles = ["crates/senpi-desktop-engine/src/main.rs", "crates/senpi-desktopish/src/lib.rs"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, false);
		assert.deepEqual(result.runtimeFiles, ["crates/senpi-desktop-engine/src/main.rs"]);
	});

	it("passes when only scripts and examples change", () => {
		// Given
		const changedFiles = ["scripts/local-release.mjs", "packages/senpi-codemode/examples/demo.ts"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});

	it("passes when only generated model catalogs change (cl.md audit skip rule)", () => {
		// Given
		const changedFiles = [
			"packages/ai/src/models.generated.ts",
			"packages/ai/src/image-models.generated.ts",
		];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});
});

// #1884: drive the real CLI over committed diffs, including the actual release transformation.
it("keeps released changelog sections immutable through the PR gate CLI", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "changelog-gate-1884-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
	writeFileSync(env.GIT_CONFIG_GLOBAL, "");
	const git = (...args) => {
		const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git("init", "-q");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	const original = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- pending\n\n## [2026.9.20] - 2026-09-20\n\n### Fixed\n\n- published\n";
	for (const file of CHANGELOGS) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), original);
	}
	git("add", ...CHANGELOGS);
	git("commit", "-qm", "upstream fixture");
	mkdirSync(join(root, ".github"));
	writeFileSync(join(root, ".github/upstream.json"), JSON.stringify({ sha: git("rev-parse", "HEAD") }));
	git("add", ".github/upstream.json");
	git("commit", "-qm", "base fixture");
	const base = git("rev-parse", "HEAD");
	const file = "packages/coding-agent/CHANGELOG.md";
	const cli = fileURLToPath(new URL("./check-pr-changelog.mjs", import.meta.url));
	const check = (text, expected, labels = "") => {
		if (text === null) rmSync(join(root, file));
		else writeFileSync(join(root, file), text);
		git("add", file);
		git("commit", "--allow-empty", "-qm", "scenario fixture");
		const result = spawnSync(process.execPath, [cli, "--base", base, "--labels", labels], {
			cwd: root, env, encoding: "utf8", timeout: 30_000,
		});
		assert.equal(result.status, expected, result.stdout + result.stderr);
		if (expected === 1) assert.match(result.stdout + result.stderr, /packages\/coding-agent\/CHANGELOG\.md:\d+.*2026\.9\.20/);
	};
	for (const [name, text, labels] of [
		["addition", `${original}- misplaced\n`, ""],
		["modification", original.replace("- published", "- changed"), ""],
		["deletion", original.replace("- published\n", ""), ""],
		["deleted file", null, ""],
		["Unreleased below a release", `${original}## [Unreleased]\n- misplaced\n`, ""],
		["label cannot bypass", `${original}- misplaced\n`, "no-changelog"],
	]) await t.test(name, () => check(text, 1, labels));
	await t.test("Unreleased entry", () => check(original.replace("- pending", "- new\n- pending"), 0));
	writeFileSync(join(root, file), original);
	const cwd = process.cwd();
	const captured = new Map();
	try {
		process.chdir(root);
		stampChangelogs("2026.9.21", "2026-09-21", false, captured, () => {}, () => {});
		await t.test("release stamp", () => check(readFileSync(file, "utf8"), 0));
		reAddUnreleasedSections("2026.9.21", "2026-09-21", false, captured, () => {}, () => {});
		await t.test("next cycle", () => check(readFileSync(file, "utf8"), 0));
	} finally {
		process.chdir(cwd);
	}
});
