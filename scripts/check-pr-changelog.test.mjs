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

// A released history past spawnSync's default 1 MiB buffer must not fail every PR with ENOBUFS.
it("gates a PR whose changelog has grown past one mebibyte", (t) => {
	const root = mkdtempSync(join(tmpdir(), "changelog-gate-large-"));
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
	const file = "packages/coding-agent/CHANGELOG.md";
	const released = Array.from({ length: 20_000 }, (_, i) => `- published fix ${i} with enough words to look like a real entry.\n`).join("");
	const original = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n## [2026.9.20] - 2026-09-20\n\n### Fixed\n\n${released}`;
	assert.ok(Buffer.byteLength(original) > 1024 * 1024);
	mkdirSync(dirname(join(root, file)), { recursive: true });
	writeFileSync(join(root, file), original);
	git("add", file);
	git("commit", "-qm", "upstream fixture");
	mkdirSync(join(root, ".github"));
	writeFileSync(join(root, ".github/upstream.json"), JSON.stringify({ sha: git("rev-parse", "HEAD") }));
	git("add", ".github/upstream.json");
	git("commit", "-qm", "base fixture");
	const base = git("rev-parse", "HEAD");
	const cli = fileURLToPath(new URL("./check-pr-changelog.mjs", import.meta.url));
	const gate = (text) => {
		writeFileSync(join(root, file), text);
		git("add", file);
		git("commit", "--allow-empty", "-qm", "scenario fixture");
		return spawnSync(process.execPath, [cli, "--base", base, "--labels", ""], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
	};

	const accepted = gate(original.replace("### Fixed\n\n## [2026.9.20]", "### Fixed\n\n- new entry\n\n## [2026.9.20]"));
	assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);

	const rejected = gate(original.replace("- published fix 19999", "- edited fix 19999"));
	assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
	assert.match(rejected.stdout + rejected.stderr, /packages\/coding-agent\/CHANGELOG\.md:\d+.*2026\.9\.20/);
});

// #2609: a PR may add entries to change logs but never delete existing ones (#2598 replaced two trackers with their new entry).
it("fails a PR that removes existing change-log lines through the PR gate CLI", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "changelog-gate-2609-"));
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
	const tracker = "packages/ai/src/changes.md";
	const changelog = "packages/ai/CHANGELOG.md";
	const entry = (title) =>
		`## 2026-10-01 - ${title}\n\n### What changed\n\n- a\n\n### Why\n\n- b\n\n### Why an extension could not handle it\n\n- c\n\n### Expected merge conflict zones\n\n- d\n`;
	const trackerOriginal = `${entry("First")}\n${entry("Second")}`;
	const changelogOriginal = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- pending fix\n\n## [2026.9.20] - 2026-09-20\n\n### Fixed\n\n- published\n";
	for (const [file, text] of [[tracker, trackerOriginal], [changelog, changelogOriginal]]) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	git("add", tracker, changelog);
	git("commit", "-qm", "upstream fixture");
	mkdirSync(join(root, ".github"));
	writeFileSync(join(root, ".github/upstream.json"), JSON.stringify({ sha: git("rev-parse", "HEAD") }));
	git("add", ".github/upstream.json");
	git("commit", "-qm", "base fixture");
	const base = git("rev-parse", "HEAD");
	const cli = fileURLToPath(new URL("./check-pr-changelog.mjs", import.meta.url));
	const check = (file, text, expected, pattern) => {
		git("reset", "-q", "--soft", base);
		for (const [path, original] of [[tracker, trackerOriginal], [changelog, changelogOriginal]]) writeFileSync(join(root, path), original);
		if (text === null) rmSync(join(root, file));
		else writeFileSync(join(root, file), text);
		git("add", "-A");
		git("commit", "--allow-empty", "-qm", "scenario fixture");
		const result = spawnSync(process.execPath, [cli, "--base", base, "--labels", ""], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, expected, result.stdout + result.stderr);
		if (pattern) assert.match(result.stdout + result.stderr, pattern);
	};
	await t.test("tracker rewritten to only its new entry", () =>
		check(tracker, entry("New"), 1, /packages\/ai\/src\/changes\.md: removes \d+ existing line/));
	await t.test("deleted tracker", () => check(tracker, null, 1, /packages\/ai\/src\/changes\.md: removes \d+ existing line/));
	await t.test("tracker prepend", () => check(tracker, `${entry("New")}\n${trackerOriginal}`, 0));
	await t.test("deleted Unreleased entry", () =>
		check(changelog, changelogOriginal.replace("- pending fix\n", "- replacement\n"), 1, /packages\/ai\/CHANGELOG\.md: removes 1 existing \[Unreleased\] line/));
	await t.test("Unreleased prepend", () => check(changelog, changelogOriginal.replace("- pending fix", "- new fix\n- pending fix"), 0));
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
