import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	type CursorExecBridgeSession,
	createSessionCursorExecBridge,
} from "../../../src/core/cursor-exec-bridge-session.ts";

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

function createSessionRef(tool: AgentTool): { current: CursorExecBridgeSession } {
	return {
		current: {
			getRegisteredTool: (name) => (name === "read" ? tool : undefined),
			preflightToolCall: async () => undefined,
		},
	};
}

function createStreamingAgent(): {
	agent: Agent;
	started: Promise<void>;
	finish: () => void;
} {
	const started = createDeferred();
	const stream = new MockAssistantStream();
	let streamIndex = 0;
	const agent = new Agent({
		streamFn: () => {
			if (streamIndex++ === 0) {
				started.resolve();
				return stream;
			}
			return new MockAssistantStream();
		},
	});
	return {
		agent,
		started: started.promise,
		finish: () => stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") }),
	};
}

function asToolResult(value: unknown): ToolResultMessage {
	expect(value).toMatchObject({ role: "toolResult" });
	return value as ToolResultMessage;
}

// Production wiring (sdk.ts + agent-loop.ts): the bridge receives the loop's
// per-request controller signal, which is always a different object than the
// agent's per-run controller signal. Issue 1003: the bridge compared the two
// by identity, so every live frame was refused with "no active run".
describe("cursor exec bridge resolves ownership by run liveness (issue 1003)", () => {
	it("executes a live frame whose request signal is not the agent's run signal object", async () => {
		const { agent, started, finish } = createStreamingAgent();
		const externalEvents: AgentEvent[] = [];
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				externalEvents.push(event);
			}
		});
		const execute = vi.fn();
		const sessionRef = createSessionRef(stubReadTool(execute));

		// given a run is live and the bridge is bound to that run's request signal
		const run = agent.prompt("live run");
		await started;
		const requestController = new AbortController();
		expect(agent.signal).toBeDefined();
		expect(requestController.signal).not.toBe(agent.signal);
		const bridge = createSessionCursorExecBridge(sessionRef, () => agent, requestController.signal);

		// when the run's stream dispatches an exec frame
		const result = asToolResult(await bridge.read?.({ path: "a.ts", toolCallId: "call-live" } as never));

		// then the tool executes; lifecycle events carry the request signal and
		// Agent.emitExternalEvent drops them rather than leaking into the run
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "read ok" }]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(externalEvents).toEqual([]);

		finish();
		await run;
	});

	it("refuses a frame whose request signal has been aborted", async () => {
		const { agent, started, finish } = createStreamingAgent();
		const execute = vi.fn();
		const sessionRef = createSessionRef(stubReadTool(execute));

		const run = agent.prompt("live run");
		await started;
		const requestController = new AbortController();
		const bridge = createSessionCursorExecBridge(sessionRef, () => agent, requestController.signal);

		// the loop tore the request down (run aborted or idle timeout) while the
		// stream still held a buffered frame
		requestController.abort();

		const result = asToolResult(await bridge.read?.({ path: "a.ts", toolCallId: "call-aborted" } as never));

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: "Tool execution has no active run" });
		expect(execute).not.toHaveBeenCalled();

		finish();
		await run;
	});

	it("refuses a live frame when no run is active", async () => {
		const agent = new Agent({ streamFn: () => new MockAssistantStream() });
		const execute = vi.fn();
		const sessionRef = createSessionRef(stubReadTool(execute));

		expect(agent.signal).toBeUndefined();
		const bridge = createSessionCursorExecBridge(sessionRef, () => agent, new AbortController().signal);

		const result = asToolResult(await bridge.read?.({ path: "a.ts", toolCallId: "call-no-run" } as never));

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: "Tool execution has no active run" });
		expect(execute).not.toHaveBeenCalled();
	});

	it("falls back to the agent run signal when no request signal is supplied", async () => {
		const { agent, started, finish } = createStreamingAgent();
		const execute = vi.fn();
		const sessionRef = createSessionRef(stubReadTool(execute));

		const run = agent.prompt("live run");
		await started;
		const bridge = createSessionCursorExecBridge(sessionRef, () => agent);

		const result = asToolResult(await bridge.read?.({ path: "a.ts", toolCallId: "call-legacy" } as never));

		expect(result.isError).toBe(false);
		expect(execute).toHaveBeenCalledTimes(1);

		finish();
		await run;
	});
});
