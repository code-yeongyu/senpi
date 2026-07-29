import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { countContinuationRequests } from "./lib/goal-continuation-classifier.mjs";
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

test("/goal resume drives a paused Goal through an automatic todo-gated continuation", async () => {
	const scratch = makeScratch("goal-resume-continuation");
	const fake = await startFakeModelServer([
		{ toolCalls: [{ name: "todo", args: { op: "init", items: ["finish"] } }] },
		{ toolCalls: [{ name: "update_goal", args: { status: "complete" } }] },
		{ toolCalls: [{ name: "todo", args: { op: "done", task: "finish" } }] },
		{ toolCalls: [{ name: "update_goal", args: { status: "complete" } }] },
		{ text: "done" },
	]);
	writeMockModelsJson(scratch.agentDir, fake);
	const transcript = [];
	const client = new StdioRpcClient(spawnCli(["app-server"], scratch), transcript, "goal-resume-continuation");
	await initialize(client, "qa-goal-resume-continuation");
	const threadId = requiredThreadId(await client.request("thread/start", makeThreadStartParams(scratch.cwd)));
	await client.request("thread/goal/set", { threadId, objective: "resume todo-gated goal", status: "paused" });

	const mark = client.mark();
	const completeGoal = watchForGoalState(
		scratch.sessionDir,
		threadId,
		(goal) => goal?.status === "complete",
		"resumed Goal complete",
		30_000,
	);
	const idle = client.waitForMessageEvent(
		(message) =>
			message.method === "thread/status/changed" &&
			message.params?.threadId === threadId &&
			message.params?.status?.type === "idle",
		mark,
		30_000,
	);

	await client.request("turn/start", { threadId, input: makeTextInput("/goal resume") }, 30_000);
	const [goal] = await Promise.all([completeGoal, idle]);
	const thread = await client.request("thread/read", { threadId });
	const exchanges = providerToolExchanges(fake.requests);
	const todoInitIndex = exchanges.findIndex(
		(exchange) => exchange.name === "todo" && exchange.args?.op === "init" && exchange.args.items?.join("|") === "finish",
	);
	const rejectedCompletionIndex = exchanges.findIndex(
		(exchange) => exchange.name === "update_goal" && exchange.args?.status === "complete" && /cannot mark the goal complete: 1 open todo task\(s\) remain: "finish"/i.test(exchange.result),
	);
	const todoDoneIndex = exchanges.findIndex(
		(exchange) => exchange.name === "todo" && exchange.args?.op === "done" && exchange.args.task === "finish",
	);
	const acceptedCompletionIndex = exchanges.findIndex(
		(exchange) => exchange.name === "update_goal" && exchange.args?.status === "complete" && /"status":\s*"complete"/.test(exchange.result),
	);

	assert.ok(countContinuationRequests(fake.requests) >= 1, transcript.join("\n"));
	assert.equal(exchanges.every((exchange) => exchange.name === "todo" || exchange.name === "update_goal"), true, JSON.stringify(exchanges));
	assert.ok(todoInitIndex >= 0, `missing builtin todo init exchange in ${JSON.stringify(exchanges)}`);
	assert.ok(rejectedCompletionIndex > todoInitIndex, `missing rejected premature update_goal exchange in ${JSON.stringify(exchanges)}`);
	assert.ok(todoDoneIndex > rejectedCompletionIndex, `missing builtin todo done exchange in ${JSON.stringify(exchanges)}`);
	assert.ok(acceptedCompletionIndex > todoDoneIndex, `missing final accepted update_goal exchange in ${JSON.stringify(exchanges)}`);
	assert.equal(goal.status, "complete");
	assert.equal(thread.thread.turns.filter((turn) => turn.status === "inProgress").length, 0);
	assert.equal(
		client.messages.slice(mark).filter((message) => message.method === "turn/started").length -
			client.messages.slice(mark).filter((message) => message.method === "turn/completed").length,
		0,
	);
	client.close();
}, 45_000);

function providerToolExchanges(requests) {
	const exchanges = [];
	for (const request of requests) {
		const messages = request.messages ?? [];
		for (let index = 0; index < messages.length; index += 1) {
			for (const call of messages[index]?.tool_calls ?? []) {
				const result = messages.slice(index + 1).find((message) => message.role === "tool" && message.tool_call_id === call.id);
				if (result === undefined) continue;
				let args;
				try {
					args = JSON.parse(call.function?.arguments ?? "{}");
				} catch {
					args = undefined;
				}
				const exchange = { name: call.function?.name, args, result: result.content };
				if (!exchanges.some((candidate) => JSON.stringify(candidate) === JSON.stringify(exchange))) exchanges.push(exchange);
			}
		}
	}
	return exchanges;
}
