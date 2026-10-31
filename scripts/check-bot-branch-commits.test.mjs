import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-bot-branch-commits.mjs", import.meta.url));
const BOT = "actions@github.com";

function repoWithBotBranch() {
	const dir = mkdtempSync(join(tmpdir(), "bot-branch-"));
	const git = (args, email = "dev@example.com") =>
		execFileSync("git", args, {
			cwd: dir,
			env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: email },
			encoding: "utf8",
		});
	git(["init", "-q", "-b", "main"]);
	writeFileSync(join(dir, "data.json"), "{}");
	git(["add", "."]);
	git(["commit", "-qm", "base"]);
	git(["checkout", "-qb", "automation/refresh"]);
	writeFileSync(join(dir, "data.json"), '{"v":1}');
	git(["commit", "-qam", "fix(ai): refresh the catalog"], BOT);
	return { dir, git };
}

function run(dir, scriptPath = script) {
	return spawnSync("node", [scriptPath, "--base", "main", "--head", "automation/refresh", "--bot-email", BOT], {
		cwd: dir,
		encoding: "utf8",
	});
}

test("passes a branch that holds only the bot's regeneration", () => {
	const { dir } = repoWithBotBranch();
	try {
		const result = run(dir);
		assert.equal(result.status, 0, result.stderr);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refuses a branch with a hand commit on top of the bot's (#3243)", () => {
	const { dir, git } = repoWithBotBranch();
	try {
		writeFileSync(join(dir, "CHANGELOG.md"), "hand edit");
		git(["add", "."]);
		git(["commit", "-qm", "docs(changelog): restore an entry after the merge"]);
		const result = run(dir);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /carries 1 commit\(s\) not written by actions@github\.com/);
		assert.match(result.stderr, /dev@example\.com docs\(changelog\): restore an entry/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refuses a hand merge of main into the bot branch", () => {
	const { dir, git } = repoWithBotBranch();
	try {
		git(["checkout", "-q", "main"]);
		writeFileSync(join(dir, "other.txt"), "main moved");
		git(["add", "."]);
		git(["commit", "-qm", "main moves"]);
		git(["checkout", "-q", "automation/refresh"]);
		git(["merge", "-q", "--no-edit", "main"]);
		const result = run(dir);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Merge branch 'main'/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refuses a commit the bot authored but a person committed", () => {
	const { dir } = repoWithBotBranch();
	try {
		writeFileSync(join(dir, "data.json"), '{"v":2}');
		execFileSync("git", ["commit", "-qam", "fix(ai): refresh again"], {
			cwd: dir,
			env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: BOT, GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "dev@example.com" },
		});
		const result = run(dir);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /\[committer dev@example\.com\] fix\(ai\): refresh again/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("still checks when started through a symlinked path with a space", () => {
	const { dir, git } = repoWithBotBranch();
	const scriptsDir = mkdtempSync(join(tmpdir(), "bot branch script-"));
	try {
		writeFileSync(join(dir, "CHANGELOG.md"), "hand edit");
		git(["add", "."]);
		git(["commit", "-qm", "docs(changelog): hand edit"]);
		const copied = join(scriptsDir, "real dir", "check.mjs");
		mkdirSync(join(scriptsDir, "real dir"));
		copyFileSync(script, copied);
		const linked = join(scriptsDir, "linked check.mjs");
		symlinkSync(copied, linked);
		for (const scriptPath of [copied, linked]) {
			const result = run(dir, scriptPath);
			assert.equal(result.status, 1, `${scriptPath} exited ${result.status}: ${result.stdout}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(scriptsDir, { recursive: true, force: true });
	}
});
