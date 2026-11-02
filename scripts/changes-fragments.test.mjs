#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFragment, planCompile } from "./changes-fragments.mjs";
import { collectFragmentFacts } from "./changes-fragments-gate.mjs";
import { checkPrChangelog } from "./check-pr-changelog.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sync-changes-fragments.mjs");
const CHANGELOG = "packages/ai/CHANGELOG.md";
const LOG =
	"# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Fixed\n\n- older fix\n\n## [2026.10.19] - 2026-10-19\n\n### Fixed\n\n- shipped\n";
const TRACKER = "packages/ai/src/changes.md";
const ENTRY = (title, path = "packages/ai/src/a.ts") =>
	`## 2026-10-20 - ${title}\n\n### What changed\n\n- \`${path}\`: ${title}.\n\n### Why\n\n- x\n\n### Why an extension could not handle it\n\n- x\n\n### Expected merge conflict zones\n\n- LOW\n`;
const OLD = "## 2026-10-01 - Old\n\n### What changed\n\n- old\n";
const fragment = (title) =>
	`<!-- changes-log: ${TRACKER} -->\n${ENTRY(title)}\n<!-- changes-log: ${CHANGELOG} -->\n### Fixed\n- ${title} (#1)\n`;

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
const write = (cwd, path, text) => {
	mkdirSync(dirname(join(cwd, path)), { recursive: true });
	writeFileSync(join(cwd, path), text);
};
const repo = (run) => {
	const cwd = mkdtempSync(join(tmpdir(), "senpi-fragments-"));
	try {
		git(cwd, "init", "-q", "-b", "main");
		git(cwd, "config", "user.email", "t@example.com");
		git(cwd, "config", "user.name", "T");
		git(cwd, "config", "commit.gpgsign", "false");
		run(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
};
const commit = (cwd, message) => {
	git(cwd, "add", "-A");
	git(cwd, "commit", "-q", "-m", message);
};
const concurrentPrs = (cwd, edit) => {
	write(cwd, CHANGELOG, LOG);
	write(cwd, TRACKER, OLD);
	commit(cwd, "base");
	for (const n of [1, 2]) {
		git(cwd, "checkout", "-q", "-b", `pr-${n}`, "main");
		edit(cwd, n);
		commit(cwd, `pr-${n}`);
	}
	git(cwd, "checkout", "-q", "main");
	git(cwd, "merge", "-q", "--no-ff", "-m", "merge pr-1", "pr-1");
	return git(cwd, "merge", "--no-ff", "-m", "merge pr-2", "pr-2").status;
};

describe("concurrent PRs (senpi#3610)", () => {
	it("RED: two PRs that write into the same tracker and [Unreleased] conflict", () =>
		repo((cwd) => {
			const status = concurrentPrs(cwd, (dir, n) => {
				write(dir, TRACKER, `${ENTRY(`pr ${n}`)}\n${OLD}`);
				write(dir, CHANGELOG, LOG.replace("- older fix", `- older fix\n- pr ${n} fix`));
			});
			assert.notEqual(status, 0);
		}));
	it("GREEN: two PRs with their own fragments merge cleanly", () =>
		repo((cwd) => {
			const status = concurrentPrs(cwd, (dir, n) => write(dir, `changes/unreleased/${n}.md`, fragment(`pr ${n}`)));
			assert.equal(status, 0);
		}));
});

describe("gate facts", () => {
	const facts = (records, head, base = {}, adopted = true) =>
		collectFragmentFacts({
			records,
			readHead: (path) => head[path] ?? "",
			readBase: (path) => base[path] ?? "",
			headFiles: new Set([CHANGELOG, TRACKER, ...Object.keys(head)]),
			adopted,
		});
	it("a fragment covers its changelog and tracker, and satisfies both verdicts", () => {
		const result = facts([{ status: "A", path: "changes/unreleased/7.md" }], {
			"changes/unreleased/7.md": fragment("seven"),
		});
		assert.deepEqual(result.changelogs, [CHANGELOG]);
		assert.deepEqual(result.violations, []);
		const verdict = checkPrChangelog({
			changedFiles: ["packages/ai/src/a.ts", "changes/unreleased/7.md"],
			labels: [],
			trackerPolicy: { trackerDiffs: result.trackerEntries, existingTrackers: [TRACKER] },
			fragmentChangelogs: result.changelogs,
		});
		assert.equal(verdict.pass, true, verdict.reason);
	});
	it("refuses edits to a merged fragment, a bad name, and a missing log", () => {
		const head = {
			"changes/unreleased/x.md": fragment("x"),
			"changes/unreleased/8.md": "<!-- changes-log: nowhere/changes.md -->\n## 2026-10-20 - Lost\n",
		};
		const { violations } = facts(
			[
				{ status: "M", path: "changes/unreleased/5.md" },
				{ status: "A", path: "changes/unreleased/x.md" },
				{ status: "A", path: "changes/unreleased/8.md" },
			],
			head,
		);
		assert.match(violations.join("\n"), /immutable/);
		assert.match(violations.join("\n"), /named `<pr-number>\.md`/);
		assert.match(violations.join("\n"), /`nowhere\/changes\.md` does not exist at head/);
	});
	it("refuses direct additions only once the base adopted fragments", () => {
		const head = {
			[TRACKER]: `${ENTRY("direct")}\n${OLD}`,
			[CHANGELOG]: LOG.replace("- older fix", "- older fix\n- direct"),
		};
		const base = { [TRACKER]: OLD, [CHANGELOG]: LOG };
		const records = [
			{ status: "M", path: TRACKER },
			{ status: "M", path: CHANGELOG },
		];
		assert.equal(facts(records, head, base, true).violations.length, 2);
		assert.deepEqual(facts(records, head, base, false).violations, []);
	});
	it("a fragment that names the wrong section fails the verdict", () => {
		const bad = `<!-- changes-log: ${CHANGELOG} -->\n### Fixes\n- x\n`;
		const { violations } = facts([{ status: "A", path: "changes/unreleased/9.md" }], {
			"changes/unreleased/9.md": bad,
		});
		assert.match(violations[0], /`### Fixes` is not one of/);
		assert.equal(checkPrChangelog({ changedFiles: [], labels: [], fragmentViolations: violations }).pass, false);
	});
});

describe("compile", () => {
	it("prepends tracker entries newest PR first and appends bullets oldest PR first in their section", () => {
		const plan = planCompile(
			[
				{ path: "changes/unreleased/10.md", content: fragment("ten") },
				{ path: "changes/unreleased/11.md", content: `${fragment("eleven")}\n### Added\n- new thing\n` },
			],
			(path) => ({ [TRACKER]: OLD, [CHANGELOG]: LOG })[path] ?? "",
		);
		assert.deepEqual(plan.reasons, []);
		assert.equal(
			plan.writes.get(TRACKER),
			`${ENTRY("eleven")}\n\n${ENTRY("ten")}\n\n${OLD}`.replace(/\n\n\n/g, "\n\n"),
		);
		const log = plan.writes.get(CHANGELOG);
		assert.ok(log.includes("### Added\n\n- new thing\n"), log);
		assert.ok(log.includes("- older fix\n- ten (#1)\n- eleven (#1)\n"), log);
		assert.ok(log.endsWith("### Fixed\n\n- shipped\n"), "released section untouched");
		assert.deepEqual(plan.deletes, ["changes/unreleased/11.md", "changes/unreleased/10.md"]);
	});
	it("fails closed on one bad fragment", () => {
		const plan = planCompile([{ path: "changes/unreleased/3.md", content: "no block\n" }], () => LOG);
		assert.equal(plan.reasons.length, 1);
	});
});

describe("from-diff", () => {
	it("moves a branch's direct additions into its fragment and restores the logs", () =>
		repo((cwd) => {
			write(cwd, CHANGELOG, LOG);
			const previous = ENTRY("previous");
			write(cwd, TRACKER, previous);
			commit(cwd, "base");
			const entry = `${ENTRY("old style")}\n++ content\n++ b/${TRACKER}\n`;
			write(cwd, TRACKER, `${entry}\n${previous}`);
			write(cwd, CHANGELOG, LOG.replace("- older fix", "- older fix\n- old style fix"));
			commit(cwd, "old-style PR");
			const run = spawnSync(process.execPath, [SCRIPT, "from-diff", "--base", "HEAD~1", "--pr", "21"], {
				cwd,
				encoding: "utf8",
			});
			assert.equal(run.status, 0, run.stderr);
			assert.equal(readFileSync(join(cwd, TRACKER), "utf8"), previous);
			assert.equal(readFileSync(join(cwd, CHANGELOG), "utf8"), LOG);
			const converted = readFileSync(join(cwd, "changes/unreleased/21.md"), "utf8");
			assert.ok(converted.includes(`<!-- changes-log: ${CHANGELOG} -->\n### Fixed\n- old style fix`), converted);
			assert.equal(parseFragment(converted).blocks.find((block) => block.log === TRACKER).body, entry.trim());
		}));
	for (const heading of ["### Security", ""]) {
		it(`warns with omitted ${heading || "unheaded"} additions`, () =>
			repo((cwd) => {
				const before = LOG.replace("### Added", `${heading}\n\n- previous security note\n\n### Added`);
				write(cwd, CHANGELOG, before);
				commit(cwd, "base");
				write(
					cwd,
					CHANGELOG,
					before
						.replace("- previous security note", "- previous security note\n- new security note")
						.replace("- older fix", "- older fix\n- canonical fix"),
				);
				commit(cwd, "noncanonical addition");
				const run = spawnSync(process.execPath, [SCRIPT, "from-diff", "--base", "HEAD~1", "--pr", "21"], {
					cwd,
					encoding: "utf8",
					timeout: 30_000,
				});
				assert.equal(run.status, 0, run.stderr);
				assert.ok(run.stderr.includes(CHANGELOG), run.stderr);
				if (heading) assert.ok(run.stderr.includes(heading), run.stderr);
				assert.ok(run.stderr.includes("- new security note"), run.stderr);
				assert.ok(!run.stderr.includes("- previous security note"), run.stderr);
				assert.equal(readFileSync(join(cwd, CHANGELOG), "utf8"), before);
				const converted = parseFragment(readFileSync(join(cwd, "changes/unreleased/21.md"), "utf8"));
				assert.deepEqual(converted.reasons, []);
				assert.equal(converted.blocks[0].body, "### Fixed\n- canonical fix");
			}));
	}
});
