#!/usr/bin/env node
import { Agent } from "@earendil-works/pi-agent-core";
import { EventStream } from "@earendil-works/pi-ai";
import { createSessionCursorExecBridge } from "../../dist/core/cursor-exec-bridge-session.js";

const MODE = process.argv.includes("--unbound") ? "unbound" : "bound";

class MockStream extends EventStream {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => (event.type === "done" ? event.message : event.error),
		);
	}
}

function assistantMessage(text) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const runAStarted = deferred();
const runBStarted = deferred();
const runAStream = new MockStream();
const runBStream = new MockStream();
let index = 0;

const agent = new Agent({
	streamFn: () => {
		if (index++ === 0) {
			runAStarted.resolve();
			return runAStream;
		}
		runBStarted.resolve();
		return runBStream;
	},
});

let toolRuns = 0;
const leakedEvents = [];
agent.subscribe((event) => {
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		leakedEvents.push(event.type);
	}
});

const session = {
	getRegisteredTool: (name) =>
		name === "read"
			? {
					name: "read",
					label: "read",
					description: "qa read",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					execute: async () => {
						toolRuns++;
						return { content: [{ type: "text", text: "read ok" }], details: undefined };
					},
				}
			: undefined,
	preflightToolCall: async () => undefined,
};

const runA = agent.prompt("run A");
await runAStarted.promise;
const runASignal = agent.signal;

const bridge = createSessionCursorExecBridge(
	{ current: session },
	() => agent,
	MODE === "bound" ? runASignal : undefined,
);

runAStream.push({ type: "done", reason: "stop", message: assistantMessage("run A done") });
await runA;

const runB = agent.prompt("run B");
await runBStarted.promise;
leakedEvents.length = 0;

const late = await bridge.read({ path: "qa.txt", toolCallId: "late-frame" });

runBStream.push({ type: "done", reason: "stop", message: assistantMessage("run B done") });
await runB;

const leaked = toolRuns > 0 || leakedEvents.length > 0;
console.log(JSON.stringify({ mode: MODE, toolRuns, leakedEvents, lateIsError: late?.isError === true, leaked }, null, 1));
console.log(leaked ? "RESULT: LEAKED (dead run executed inside replacement run)" : "RESULT: CONTAINED (late frame refused)");
process.exit(leaked ? 1 : 0);
