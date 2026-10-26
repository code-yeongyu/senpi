#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFragment, planCompile } from "./changes-fragments.mjs";
import { collectFragmentFacts } from "./changes-fragments-gate.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CHANGELOG = "packages/ai/CHANGELOG.md";
const LOG = "# Changelog\n\n## [Unreleased]\n\n### Changed\n\n## [1.0.0]\n\n- Shipped.\n";

for (const kind of ["models", "opengateway"]) {
	it(`${kind} generator emits a valid numbered fragment without editing the changelog`, () => {
		const cwd = mkdtempSync(join(tmpdir(), "catalog-fragment-"));
		const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
		const write = (path, text) => {
			mkdirSync(dirname(join(cwd, path)), { recursive: true });
			writeFileSync(join(cwd, path), text);
		};
		try {
			git("init", "-q", "-b", "main");
			git("config", "user.email", "test@example.com");
			git("config", "user.name", "Test");
			const data = "packages/ai/src/providers/data/opengateway.json";
			const before = '{"openai-completions":{}}';
			const after = '{"openai-completions":{"chat:example":{"id":"example","contextWindow":1000}}}';
			write(CHANGELOG, LOG);
			write(data, before);
			git("add", ".");
			git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
			write(data, after);
			write("before.json", before);
			mkdirSync(join(cwd, "changes/unreleased"), { recursive: true });
			const path = "changes/unreleased/123.md";
			const args = kind === "models"
				? [join(ROOT, "scripts/model-catalog-refresh.mjs"), "--fragment", path, "--summary", "summary.md"]
				: [join(ROOT, "packages/ai/scripts/opengateway-catalog-diff.ts"), "--base", "before.json",
					"--head", data, "--fragment", path, "--markdown", "summary.md"];
			const run = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 30_000 });
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /changed=true/);
			const content = readFileSync(join(cwd, path), "utf8");
			const fragment = parseFragment(content);
			assert.deepEqual(fragment.reasons, []);
			assert.equal(fragment.blocks[0].log, CHANGELOG);
			assert.equal(readFileSync(join(cwd, CHANGELOG), "utf8"), LOG);
			const facts = collectFragmentFacts({
				records: [{ status: "A", path }],
				readHead: () => content,
				readBase: () => "",
				headFiles: new Set([path, CHANGELOG]),
				adopted: true,
			});
			assert.deepEqual(facts.violations, []);
			assert.deepEqual(facts.changelogs, [CHANGELOG]);
			const compile = planCompile([{ path, content }], () => LOG);
			assert.deepEqual(compile.reasons, []);
			assert.ok(compile.writes.get(CHANGELOG).includes(fragment.blocks[0].body.split("\n").at(-1)));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}
