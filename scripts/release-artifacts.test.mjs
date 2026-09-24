import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runClaudeCodeModelSupportReport, runPackageLockRefresh } from "./release-artifacts.mjs";

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
			["bun", ["install", "--lockfile-only"]],
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
			"bun install --lockfile-only",
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
