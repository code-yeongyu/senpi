import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { type CursorExecBridgeSession, createSessionCursorExecBridge } from "../src/core/cursor-exec-bridge-session.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function isToolResult(value: unknown): value is ToolResultMessage {
	return typeof value === "object" && value !== null && "role" in value && value.role === "toolResult";
}

function stubReadTool(execute: () => void): AgentTool {
	const parameters = Type.Object({ path: Type.String() });
	return {
		name: "read",
		label: "read",
		description: "stub read",
		parameters,
		execute: async () => {
			execute();
			return { content: [{ type: "text", text: "read ok" }], details: undefined };
		},
	} as unknown as AgentTool;
}

describe("cursor exec bridge run ownership across runs", () => {
	it("refuses a late exec frame from a finished run instead of leaking it into the replacement run", async () => {
		const runAStarted = createDeferred();
		const runBStarted = createDeferred();
		const runAStream = new MockAssistantStream();
		const runBStream = new MockAssistantStream();
		let streamIndex = 0;

		const agent = new Agent({
			streamFn: () => {
				if (streamIndex++ === 0) {
					runAStarted.resolve();
					return runAStream;
				}
				runBStarted.resolve();
				return runBStream;
			},
		});

		const externalEvents: AgentEvent[] = [];
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				externalEvents.push(event);
			}
		});

		const execute = vi.fn();
		const tool = stubReadTool(execute);
		const session: CursorExecBridgeSession = {
			getRegisteredTool: (name) => (name === "read" ? tool : undefined),
			preflightToolCall: async () => undefined,
			emitExecBridgeToolResult: async () => undefined,
		};
		const sessionRef = { current: session };

		// given run A is streaming and owns the Cursor exec stream
		const runA = agent.prompt("run A");
		await runAStarted.promise;
		const runASignal = agent.signal;
		expect(runASignal).toBeDefined();
		const bridge = createSessionCursorExecBridge(sessionRef, () => agent, runASignal);

		// and run A has ended while its stream still holds a buffered exec frame
		runAStream.push({ type: "done", reason: "stop", message: createAssistantMessage("run A done") });
		await runA;

		// and the fallback lane has started run B on another provider
		const runB = agent.prompt("run B");
		await runBStarted.promise;
		const runBSignal = agent.signal;
		expect(runBSignal).toBeDefined();
		expect(runBSignal).not.toBe(runASignal);
		externalEvents.length = 0;

		// when run A's straggler exec frame arrives during run B
		const late = await bridge.read?.({ path: "a.ts", toolCallId: "late-run-a-frame" } as never);

		// then it neither executes a tool nor leaks lifecycle events into run B

		expect(execute).not.toHaveBeenCalled();
		expect(externalEvents).toEqual([]);
		expect(isToolResult(late) && late.isError).toBe(true);

		runBStream.push({ type: "done", reason: "stop", message: createAssistantMessage("run B done") });
		await runB;
	});

	it("fails closed when a session bridge has no captured owning run", async () => {
		const execute = vi.fn();
		const tool = stubReadTool(execute);
		const sessionRef: { current?: CursorExecBridgeSession } = {
			current: {
				getRegisteredTool: (name) => (name === "read" ? tool : undefined),
				preflightToolCall: async () => undefined,
				emitExecBridgeToolResult: async () => undefined,
			},
		};
		const emitExternalEvent = vi.fn();
		const agent = {
			signal: new AbortController().signal,
			emitExternalEvent,
		};
		const bridge = createSessionCursorExecBridge(sessionRef, () => agent);

		const result = await bridge.read?.({ path: "a.ts", toolCallId: "unbound-frame" } as never);

		expect(execute).not.toHaveBeenCalled();
		expect(emitExternalEvent).not.toHaveBeenCalled();
		expect(isToolResult(result) && result.isError).toBe(true);
	});
});
