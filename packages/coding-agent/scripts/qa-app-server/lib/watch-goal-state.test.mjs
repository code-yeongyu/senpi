import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { watchForGoalState } from "./watch-goal-state.mjs";

test("waits through atomic Goal writes and reads only the encoded target", async () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "senpi-watch-goal-state-"));
	onTestFinished(() => rmSync(sessionDir, { recursive: true, force: true }));
	const root = join(sessionDir, "extensions", "goal");
	mkdirSync(root, { recursive: true });

	const threadId = "thread/with spaces";
	const targetName = `${encodeURIComponent(threadId)}.json`;
	const targetPath = join(root, targetName);
	const tempName = ".goal-fixture.tmp";
	const tempPath = join(root, tempName);
	const unrelatedName = "unrelated.json";
	const watcher = new FixtureWatcher();
	const reads = [];
	const waiting = watchForGoalState(
		sessionDir,
		threadId,
		(goal) => goal?.status === "paused" && goal.consecutiveContinuations === 8,
		"fixture paused Goal",
		1_000,
		{
			watchImpl(_root, listener) {
				watcher.listener = listener;
				return watcher;
			},
			readFileImpl(path, encoding) {
				reads.push(path);
				return watcher.readFile(path, encoding);
			},
		},
	);

	writeFileSync(tempPath, goalJson(threadId, 8));
	watcher.emitFile(tempName);
	writeFileSync(join(root, unrelatedName), goalJson("another-thread", 8));
	watcher.emitFile(unrelatedName);

	// An exact-name event can race ahead of the atomic rename. ENOENT is transient.
	watcher.emitFile(targetName);
	renameSync(tempPath, targetPath);
	watcher.emitFile(targetName);

	const goal = await waiting;
	assert.equal(goal.threadId, threadId);
	assert.equal(goal.consecutiveContinuations, 8);
	assert.deepEqual(reads, [targetPath, targetPath]);
	assert.equal(watcher.closed, true);
	assert.equal(watcher.listenerCount("error"), 0);
});

class FixtureWatcher extends EventEmitter {
	listener;
	closed = false;

	emitFile(fileName) {
		this.listener("rename", fileName);
	}

	readFile(path, encoding) {
		return Reflect.apply(globalReadFile, null, [path, encoding]);
	}

	close() {
		this.closed = true;
		this.removeAllListeners();
	}
}

import { readFileSync as globalReadFile } from "node:fs";

function goalJson(threadId, consecutiveContinuations) {
	return JSON.stringify({
		goal: { threadId, status: "paused", consecutiveContinuations },
	});
}
