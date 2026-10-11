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

// #3126: restoring shipped section bytes is the only exception to released immutability.
describe("tagged released section restoration", () => {
	const path = "packages/ai/CHANGELOG.md";
	const tagged = "## [2026.9.20] - 2026-09-20\n\n### Fixed\n\n- published\n";
	const before = `${tagged}- accidentally added after release\n`;
	for (const [name, after, taggedSections, pass] of [
		["restores the exact tagged section", tagged, { "2026.9.20": tagged }, true],
		["rejects a section matching neither base nor tag", tagged.replace("- published", "- changed"), { "2026.9.20": tagged }, false],
		["rejects restoration without a tag", tagged, {}, false],
		["rejects a whitespace difference from the tag", `${tagged}\n`, { "2026.9.20": tagged }, false],
	]) {
		it(name, () => {
			const result = checkPrChangelog({
				changedFiles: [path],
				labels: [],
				changelogChanges: [{ path, before, after, taggedSections }],
			});
			assert.equal(result.pass, pass, result.reason);
			if (!pass) assert.match(result.reason, /released section \[2026\.9\.20\] changed/);
		});
	}
});

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
		assert.deepEqual(result.violations, []);
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

it("returns every released-section, tracker, and Unreleased-removal violation", () => {
	const paths = ["packages/ai/CHANGELOG.md", "packages/tui/CHANGELOG.md"];
	const before = "## [Unreleased]\n- pending\n## [1.0.0]\n- first\n## [0.9.0]\n- second\n";
	const after = before
		.replace("- pending\n", "")
		.replace("- first", "- changed first")
		.replace("- second", "- changed second");
	const result = checkPrChangelog({
		changedFiles: paths,
		labels: [],
		changelogChanges: paths.map((path) => ({ path, before, after })),
		trackerRemovals: [
			{ path: "packages/ai/src/changes.md", removed: 6 },
			{ path: "packages/tui/src/changes.md", removed: 2 },
			{ path: "scripts/changes.md", removed: 0 },
		],
	});
	assert.equal(result.pass, false);
	assert.deepEqual(result.violations, [
		"packages/ai/CHANGELOG.md:3: released section [1.0.0] changed",
		"packages/ai/CHANGELOG.md:5: released section [0.9.0] changed",
		"packages/tui/CHANGELOG.md:3: released section [1.0.0] changed",
		"packages/tui/CHANGELOG.md:5: released section [0.9.0] changed",
		"packages/ai/src/changes.md: removes 6 existing line(s); tracker entries may only be added",
		"packages/tui/src/changes.md: removes 2 existing line(s); tracker entries may only be added",
		"packages/ai/CHANGELOG.md: removes 1 existing [Unreleased] entry, first: - pending",
		"packages/tui/CHANGELOG.md: removes 1 existing [Unreleased] entry, first: - pending",
	]);
	assert.equal(result.reason, result.violations.join("; "));
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
	const pending = "- pending fix ([#100](https://github.com/o/r/issues/100))";
	const changelogOriginal = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n${pending}\n\n## [2026.9.20] - 2026-09-20\n\n### Fixed\n\n- published\n`;
	for (const [file, text] of [[tracker, trackerOriginal], [changelog, changelogOriginal]]) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	git("add", tracker, changelog);
	git("commit", "-qm", "upstream fixture");
	git("tag", "v2026.9.20");
	mkdirSync(join(root, ".github"));
	writeFileSync(join(root, ".github/upstream.json"), JSON.stringify({ sha: git("rev-parse", "HEAD") }));
	git("add", ".github/upstream.json");
	git("commit", "-qm", "base fixture");
	let base = git("rev-parse", "HEAD");
	const cli = fileURLToPath(new URL("./check-pr-changelog.mjs", import.meta.url));
	const check = (file, text, expected, pattern, additionalChanges = []) => {
		git("reset", "-q", "--soft", base);
		for (const [path, original] of [[tracker, trackerOriginal], [changelog, changelogOriginal]]) writeFileSync(join(root, path), original);
		if (text === null) rmSync(join(root, file));
		else writeFileSync(join(root, file), text);
		for (const [path, content] of additionalChanges) writeFileSync(join(root, path), content);
		git("add", "-A");
		git("commit", "--allow-empty", "-qm", "scenario fixture");
		const result = spawnSync(process.execPath, [cli, "--base", base, "--labels", ""], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, expected, result.stdout + result.stderr);
		if (pattern) assert.match(result.stdout + result.stderr, pattern);
		return result.stdout + result.stderr;
	};
	// #3055: a released-section edit must not mask a tracker removal in the same PR.
	await t.test("released section edited and existing tracker lines removed", () => {
		const output = check(
			changelog,
			changelogOriginal.replace("- published", "- misplaced PR fix\n- published"),
			1,
			/packages\/ai\/CHANGELOG\.md:\d+: released section \[2026\.9\.20\] changed/,
			[[tracker, entry("New")]],
		);
		assert.match(
			output,
			/packages\/ai\/src\/changes\.md: removes \d+ existing line\(s\); tracker entries may only be added/,
		);
		assert.match(
			output,
			/^changelog-gate: FAIL - packages\/ai\/CHANGELOG\.md:\d+: released section \[2026\.9\.20\] changed\n/,
		);
		assert.match(output, /^ {2}violation: packages\/ai\/CHANGELOG\.md:\d+: released section \[2026\.9\.20\] changed$/m);
		assert.match(
			output,
			/^ {2}violation: packages\/ai\/src\/changes\.md: removes \d+ existing line\(s\); tracker entries may only be added$/m,
		);
	});
	await t.test("tracker rewritten to only its new entry", () =>
		check(tracker, entry("New"), 1, /packages\/ai\/src\/changes\.md: removes \d+ existing line/));
	await t.test("deleted tracker", () => check(tracker, null, 1, /packages\/ai\/src\/changes\.md: removes \d+ existing line/));
	await t.test("tracker prepend", () => check(tracker, `${entry("New")}\n${trackerOriginal}`, 0));
	await t.test("deleted Unreleased entry", () =>
		check(changelog, changelogOriginal.replace(`${pending}\n`, ""), 1, /packages\/ai\/CHANGELOG\.md: removes 1 existing \[Unreleased\] entry/));
	await t.test("another PR's Unreleased entry deleted while adding this PR's own", () =>
		check(
			changelog,
			changelogOriginal.replace(pending, "- this PR's fix ([#200](https://github.com/o/r/issues/200))"),
			1,
			/removes 1 existing \[Unreleased\] entry, first: - pending fix/,
		));
	await t.test("Unreleased entry credited in place", () =>
		check(changelog, changelogOriginal.replace(pending, `${pending}. Thanks to @contributor ([#300](https://github.com/o/r/pull/300))`), 0));
	await t.test("unreferenced Unreleased entry credited in place", () => {
		const bare = changelogOriginal.replace(pending, "- bare fix.");
		writeFileSync(join(root, changelog), bare);
		git("add", changelog);
		git("commit", "-qm", "bare base");
		const bareBase = git("rev-parse", "HEAD");
		writeFileSync(join(root, changelog), bare.replace("- bare fix.", "- bare fix ([#400](https://github.com/o/r/pull/400) by @someone)."));
		git("add", changelog);
		git("commit", "-qm", "credit");
		const result = spawnSync(process.execPath, [cli, "--base", bareBase, "--labels", ""], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, result.stdout + result.stderr);
	});
	await t.test("Unreleased entry reworded in place", () =>
		check(changelog, changelogOriginal.replace(pending, "- the pending fix, reworded ([#100](https://github.com/o/r/issues/100))"), 0));
	await t.test("Unreleased entry stamped into a release", () =>
		check(changelog, changelogOriginal.replace("## [Unreleased]\n", "## [Unreleased]\n\n## [2026.10.1] - 2026-10-01\n"), 0));
	await t.test("Unreleased prepend", () => check(changelog, changelogOriginal.replace(pending, `- new fix\n${pending}`), 0));
	writeFileSync(join(root, changelog), `${changelogOriginal}- accidentally added after release\n`);
	git("add", changelog);
	git("commit", "-qm", "incorrect released base");
	base = git("rev-parse", "HEAD");
	await t.test("released section restored to its real tag", () => check(changelog, changelogOriginal, 0));
	await t.test("released section differs from base and tag", () =>
		check(changelog, changelogOriginal.replace("- published", "- changed"), 1, /released section \[2026\.9\.20\] changed/));
	await t.test("released restoration without its tag fails closed", () => {
		git("tag", "-d", "v2026.9.20");
		check(changelog, changelogOriginal, 1, /released section \[2026\.9\.20\] changed/);
	});
	const commitChangelog = (text, message) => {
		writeFileSync(join(root, changelog), text);
		git("add", changelog);
		git("commit", "-qm", message);
		return git("rev-parse", "HEAD");
	};
	const withBase = (text, run) => {
		const saved = base;
		base = commitChangelog(`${text}- accidentally added after release\n`, "incorrect base");
		try {
			run();
		} finally {
			base = saved;
		}
	};
	// A section name carrying revision syntax must not resolve through the tag (`v2026.9.20~1` is the tag's parent).
	await t.test("revision syntax in a section name gets no tag exemption", () => {
		const parentShaped = changelogOriginal.replace("## [2026.9.20]", "## [2026.9.20~1]");
		commitChangelog(parentShaped, "tag parent holding the parent-shaped section");
		git("tag", "v2026.9.20", commitChangelog(changelogOriginal, "tagged release"));
		withBase(parentShaped, () => check(changelog, parentShaped, 1, /released section \[2026\.9\.20~1\] changed/));
	});
	// Only CalVer release names are exempt, even when a matching `v<name>` tag exists.
	await t.test("non-CalVer section name with a matching tag gets no exemption", () => {
		const named = changelogOriginal.replace("## [2026.9.20]", "## [next]");
		git("tag", "vnext", commitChangelog(named, "non-CalVer tag"));
		withBase(named, () => check(changelog, named, 1, /released section \[next\] changed/));
	});
	// A tag that lacks the changelog gives the normal FAIL, not a git error.
	await t.test("tag without the changelog file fails the normal way", () => {
		git("tag", "-d", "v2026.9.20");
		const emptyTree = git("hash-object", "-t", "tree", "/dev/null");
		git("tag", "v2026.9.20", git("commit-tree", emptyTree, "-m", "tag without the changelog"));
		const output = check(changelog, changelogOriginal, 1, /^changelog-gate: FAIL - packages\/ai\/CHANGELOG\.md:\d+: released section \[2026\.9\.20\] changed$/m);
		assert.doesNotMatch(output, /fatal:|ERROR/);
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
