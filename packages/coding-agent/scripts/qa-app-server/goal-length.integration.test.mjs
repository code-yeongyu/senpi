import assert from "node:assert/strict";
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

test("a real app-server thread persists a length-stopped active Goal as paused with its reason", async () => {
	const scratch = makeScratch("goal-length-integration");
	const fake = await startFakeModelServer([{ text: "truncated fixture", finishReason: "length" }]);
	writeMockModelsJson(scratch.agentDir, fake);
	const transcript = [];
	const client = new StdioRpcClient(spawnCli(["app-server"], scratch), transcript, "goal-length-integration");
	await initialize(client, "qa-goal-length-integration");
	const threadId = requiredThreadId(await client.request("thread/start", makeThreadStartParams(scratch.cwd)));
	await client.request("thread/goal/set", { threadId, objective: "length fixture goal", status: "active" });

	const pausedWrite = watchForGoalState(
		scratch.sessionDir,
		threadId,
		(goal) => goal?.status === "paused" && goal.blockedReason === "output length",
		"length-stopped exact paused Goal",
		30_000,
	);
	const mark = client.mark();
	const turnCompleted = client.waitForMessageEvent(
		(message) => message.method === "turn/completed" && message.params?.threadId === threadId,
		mark,
		30_000,
	);

	await client.request("turn/start", { threadId, input: makeTextInput("trigger the length response") }, 30_000);
	const [goal, terminal] = await Promise.all([pausedWrite, turnCompleted]);

	assert.equal(terminal.params?.turn?.status, "completed", transcript.join("\n"));
	assert.equal(goal.threadId, threadId);
	assert.equal(goal.status, "paused");
	assert.equal(goal.blockedReason, "output length");
	assert.equal(fake.requests.length, 1);
	client.close();
}, 45_000);
