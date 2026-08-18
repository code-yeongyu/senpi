import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { syncRemoteMainBeforePush } from "./release-git.mjs";

describe("release main synchronization", () => {
	it("merges a concurrently advanced remote main before pushing", () => {
		const commands = [];
		syncRemoteMainBeforePush(
			false,
			(command, args) => {
				commands.push([command, args]);
				if (args[0] === "merge-base") {
					throw new Error("remote main advanced");
				}
			},
			() => {},
			() => {},
		);

		assert.deepEqual(commands, [
			["git", ["fetch", "origin", "main"]],
			["git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]],
			["git", ["merge", "--no-edit", "origin/main"]],
		]);
	});

	it("does not create a merge when remote main is already included", () => {
		const commands = [];
		syncRemoteMainBeforePush(
			false,
			(command, args) => commands.push([command, args]),
			() => {},
			() => {},
		);

		assert.deepEqual(commands, [
			["git", ["fetch", "origin", "main"]],
			["git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]],
		]);
	});

	it("previews the fetch and conditional merge", () => {
		const previews = [];
		syncRemoteMainBeforePush(
			true,
			() => assert.fail("dry-run must not execute commands"),
			() => {},
			(message) => previews.push(message),
		);

		assert.deepEqual(previews, [
			"git fetch origin main",
			"git merge --no-edit origin/main (if remote main advanced)",
		]);
	});

	it("synchronizes remote main after the next-cycle commit and before either push", () => {
		const releaseSource = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
		const nextCycleCommit = releaseSource.indexOf('gitCommit("Add [Unreleased] section for next cycle"');
		const synchronize = releaseSource.indexOf("syncRemoteMainBeforePush(");
		const pushMain = releaseSource.indexOf('gitPush("main"');
		const pushTag = releaseSource.indexOf("gitPush(`v${version}`");

		assert.ok(nextCycleCommit < synchronize);
		assert.ok(synchronize < pushMain);
		assert.ok(pushMain < pushTag);
	});
});
