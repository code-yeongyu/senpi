#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./publish-catalog-refresh.mjs", import.meta.url));
const FRAGMENT = "<!-- changes-log: packages/ai/CHANGELOG.md -->\n### Changed\n- Catalog refreshed.\n";

for (const existing of [false, true]) {
	for (const wrongPr of [false, true]) {
		it(`${existing ? "existing" : "new"} refresh ${wrongPr ? "refuses the wrong PR" : "publishes only its numbered fragment"}`, () => {
			const root = mkdtempSync(join(tmpdir(), "publish-catalog-"));
			const cwd = join(root, "repo");
			const bare = join(root, "remote.git");
			const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
			try {
				mkdirSync(cwd);
				mkdirSync(join(root, "bin"));
				execFileSync("git", ["init", "--bare", "-q", bare]);
				git("init", "-q", "-b", "main");
				git("config", "user.name", "Test");
				git("config", "user.email", "test@example.com");
				git("config", "commit.gpgsign", "false");
				writeFileSync(join(cwd, "catalog.json"), "{}\n");
				git("add", "catalog.json");
				git("commit", "-qm", "base");
				git("remote", "add", "origin", bare);
				const base = git("rev-parse", "HEAD");
				writeFileSync(join(cwd, "catalog.json"), '{"models":1}\n');
				writeFileSync(join(root, "fragment.md"), FRAGMENT);
				writeFileSync(join(root, "summary.md"), "Catalog summary\n");
				const calls = join(root, "calls.jsonl");
				writeFileSync(join(root, "bin", "gh"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const a = process.argv.slice(2);
const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {encoding:"utf8"});
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:a, tree, token:process.env.GH_TOKEN})+"\\n");
if (a[0] === "pr" && a[1] === "list") console.log(${JSON.stringify(existing ? '[{"number":123}]' : '[]')});
else if (a[0] === "pr" && a[1] === "create") console.log("https://github.com/test/catalog/pull/123");
else if (a[0] === "pr" && a[1] === "view") console.log(JSON.stringify({
number:123,url:"https://github.com/test/catalog/pull/123",
headRefName:${JSON.stringify(wrongPr ? "unrelated-branch" : "automation/catalog")},baseRefName:"main",state:"OPEN",isCrossRepository:false,isDraft:${!existing}
}));
`, { mode: 0o755 });
				const run = spawnSync(process.execPath, [
					SCRIPT, "--title", "fix(ai): refresh catalog", "--summary", join(root, "summary.md"),
					"--fragment", join(root, "fragment.md"), "--auto-merge", "--", "catalog.json",
				], {
					cwd, encoding: "utf8", timeout: 30_000,
					env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
						GITHUB_REPOSITORY: "test/catalog", REFRESH_BRANCH: "automation/catalog",
						GH_TOKEN: "fixture-pat", CHANGED: "true" },
				});
				const events = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
				if (wrongPr) {
					assert.equal(run.status, 1, run.stderr);
					assert.ok(!existsSync(join(cwd, "changes/unreleased/123.md")));
					assert.ok(events.every(({ args }) => args[1] !== "ready" && args[1] !== "merge"));
					if (existing) assert.equal(git("rev-parse", "HEAD"), base);
				} else {
					assert.equal(run.status, 0, run.stderr);
					assert.equal(git("--git-dir", bare, "show", "refs/heads/automation/catalog:changes/unreleased/123.md"), FRAGMENT.trim());
					assert.equal(git("rev-list", "--count", `${base}..HEAD`), existing ? "1" : "2");
					assert.ok(!git("log", "-1", "--format=%B").includes("[skip ci]"));
					assert.ok(events.every(({ token }) => token === "fixture-pat"));
					const created = events.find(({ args }) => args[1] === "create");
					if (!existing) {
						assert.ok(git("log", "-1", "--format=%B", "HEAD~1").includes("[skip ci]"));
						assert.ok(created.args.includes("--draft"));
						assert.ok(!created.tree.includes("changes/unreleased/123.md"));
						const ready = events.find(({ args }) => args[1] === "ready");
						assert.ok(ready.tree.includes("changes/unreleased/123.md"));
					} else assert.equal(created, undefined);
					assert.ok(events.some(({ args }) => args[0] === "auth" && args[1] === "setup-git"));
					assert.ok(events.some(({ args }) => args[1] === "merge"));
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
}
