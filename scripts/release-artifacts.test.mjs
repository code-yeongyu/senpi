import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runClaudeCodeModelSupportReport, runPackageLockRefresh, runProviderDefaultsCheck } from "./release-artifacts.mjs";

describe("release package-lock refresh", () => {
	it("refreshes package-lock.json, reconciles native optionals, then refreshes bun.lock", () => {
		const commands = [];
		runPackageLockRefresh(
			false,
			(command, args) => commands.push([command, args]),
			() => {},
			() => {},
		);

		assert.deepEqual(commands, [
			["npm", ["install", "--package-lock-only", "--ignore-scripts"]],
			["npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]],
			// senpi#2352: an in-place `bun install --lockfile-only` left stale workspace ranges behind.
			["node", ["scripts/regenerate-bun-lock-isolated.mjs"]],
		]);
	});

	it("previews the npm lock refresh, the native optional reconciliation, and the bun.lock refresh", () => {
		const previews = [];
		runPackageLockRefresh(
			true,
			() => assert.fail("dry-run must not execute commands"),
			() => {},
			(message) => previews.push(message),
		);

		assert.deepEqual(previews, [
			"npm install --package-lock-only --ignore-scripts",
			"npm install --ignore-scripts --no-audit --no-fund",
			"node scripts/regenerate-bun-lock-isolated.mjs",
		]);
	});
});

describe("release Claude Code model-support report (omo#8700)", () => {
	it("reports the regenerated catalog against the pinned Claude Code without failing the release on catalog-only gaps", () => {
		const commands = [];
		runClaudeCodeModelSupportReport(
			false,
			(command, args) => commands.push([command, args]),
			() => {},
			() => {},
		);

		assert.deepEqual(commands, [["node", ["scripts/check-claude-code-model-support.mjs"]]]);
	});
});

describe("release provider-default check (senpi#2645)", () => {
	it("checks every bundled provider default against the regenerated catalog", () => {
		const commands = [];
		runProviderDefaultsCheck(
			false,
			(command, args, env) => commands.push([command, args, env]),
			() => {},
			() => {},
		);

		assert.deepEqual(commands, [["npm", ["--prefix", "packages/coding-agent", "run", "check:provider-defaults"], { CI: "1" }]]);
	});

	it("stops the release when a regenerated catalog lost a provider default", () => {
		const failingCheck = () => {
			throw new Error("Command failed: npm --prefix packages/coding-agent run check:provider-defaults (exit 1)");
		};

		assert.throws(() => runProviderDefaultsCheck(false, failingCheck, () => {}, () => {}), /check:provider-defaults/);
	});
});

describe("release npm script references", () => {
	it("runs only npm scripts that the target package defines", () => {
		const sources = ["release-artifacts.mjs", "release.mjs"].map((file) =>
			readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
		);
		const calls = [];
		for (const source of sources) {
			for (const match of source.matchAll(/runCommand\("npm", \[(?:"--prefix", "([^"]+)", )?"run", "([^"]+)"/g)) {
				calls.push({ dir: match[1] ?? ".", script: match[2] });
			}
		}
		assert.ok(calls.length > 0, "expected npm run calls in the release scripts");
		for (const { dir, script } of calls) {
			const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), "utf8"));
			assert.ok(manifest.scripts?.[script], `${dir}/package.json has no "${script}" script`);
		}
	});
});
