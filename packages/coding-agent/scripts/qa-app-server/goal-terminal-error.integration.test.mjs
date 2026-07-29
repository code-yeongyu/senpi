import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	cleanupAllAndWait,
	makeScratch,
	makeTextInput,
	makeThreadStartParams,
	spawnCli,
	startFakeModelServer,
	writeMockModelsJson,
} from "./lib/env.mjs";
import { initialize, requiredThreadId, StdioRpcClient } from "./lib/rpc.mjs";
import { watchForGoalState } from "./lib/watch-goal-state.mjs";

afterEach(async () => {
	await cleanupAllAndWait();
});

test("a non-retryable HTTP provider error pauses an active Goal without continuing retries", async () => {
	const scratch = makeScratch("goal-terminal-error-integration");
	const fake = await startFakeModelServer([{ error: { status: 400, message: "invalid fixture request" } }]);
	writeMockModelsJson(scratch.agentDir, fake);
	const transcript = [];
	const client = new StdioRpcClient(spawnCli(["app-server"], scratch), transcript, "goal-terminal-error-integration");
	await initialize(client, "qa-goal-terminal-error-integration");
	const threadId = requiredThreadId(await client.request("thread/start", makeThreadStartParams(scratch.cwd)));

	const goalRoot = join(scratch.sessionDir, "extensions", "goal");
	mkdirSync(goalRoot, { recursive: true });
	const pausedWrite = watchForGoalState(
		scratch.sessionDir,
		threadId,
		(goal) => goal?.status === "paused" && goal.blockedReason === "terminal provider error",
		"terminal-error exact paused Goal",
		10_000,
	);
	await client.request("thread/goal/set", { threadId, objective: "terminal provider error fixture goal", status: "active" });

	const mark = client.mark();
	const turnCompleted = client.waitForMessageEvent(
		(message) => message.method === "turn/completed" && message.params?.threadId === threadId,
		mark,
		10_000,
	);
	await client.request("turn/start", { threadId, input: makeTextInput("trigger the terminal provider error") }, 10_000);
	const [goal, terminal] = await Promise.all([pausedWrite, turnCompleted]);

	assert.equal(terminal.params?.turn?.status, "completed", transcript.join("\n"));
	assert.equal(goal.threadId, threadId);
	assert.equal(goal.status, "paused");
	assert.equal(goal.blockedReason, "terminal provider error");
	assert.equal(fake.requests.length, 1, "non-retryable fixture must make exactly one provider request");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fake.requests.length, 1, "provider retries continued after Goal paused");
	client.close();
}, 15_000);
