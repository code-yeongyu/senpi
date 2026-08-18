import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPackageLockRefresh } from "./release-artifacts.mjs";

describe("release package-lock refresh", () => {
	it("reconciles native optional packages after the host-specific lock refresh", () => {
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
		]);
	});

	it("previews both lock refresh and native optional reconciliation", () => {
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
		]);
	});
});
