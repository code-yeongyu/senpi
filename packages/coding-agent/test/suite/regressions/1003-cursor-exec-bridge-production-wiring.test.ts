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

/**
 * Production wiring of the Cursor exec bridge, end to end.
 *
 * Every other bridge test constructs `createSessionCursorExecBridge` by hand
 * and hands it a signal the test chose. That leaves the actual production
 * seam untested: `sdk.ts` registers the bridge as a *factory*
 * (`cursorExecHandlers: (runSignal) => createSessionCursorExecBridge(...)`)
 * and the agent loop is what decides which signal that factory receives
 * (`agent-loop.ts`, issue #1002: the owning RUN signal, not the per-request
 * idle-timeout controller). A bridge bound to the wrong signal fails the
 * `getAbortSignal` ownership check and refuses every live exec frame with
 * "Tool execution has no active run" — the #1003 field regression, invisible
 * to hand-wired tests because they inject a matching signal.
 *
 * This test reproduces that wiring exactly: a real `Agent`, the real factory,
 * and a stream function that dispatches exec frames onto whatever handlers
 * the loop actually built.
 */

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
		api: "cursor-agent",
		provider: "cursor",
		model: "mock-cursor",
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

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function isToolResult(value: unknown): value is ToolResultMessage {
	return typeof value === "object" && value !== null && "role" in value && value.role === "toolResult";
}

function stubReadTool(execute: () => void): AgentTool {
	return {
		name: "read",
		label: "read",
		description: "stub read",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => {
			execute();
			return { content: [{ type: "text", text: "read ok" }], details: undefined };
		},
	} as unknown as AgentTool;
}

/** Handlers the loop built for one provider request, as the Cursor API would receive them. */
type ExecHandlers = { read?: (args: unknown) => Promise<unknown> };

type ToolLifecycleEvent = Extract<AgentEvent, { type: "tool_execution_start" | "tool_execution_end" }>;

describe("cursor exec bridge production wiring (issue #1003)", () => {
	it("executes a live frame on the run that owns it and refuses it once a replacement run is active", async () => {
		const execute = vi.fn();
		const tool = stubReadTool(execute);
		const session: CursorExecBridgeSession = {
			getRegisteredTool: (name) => (name === "read" ? tool : undefined),
			preflightToolCall: async () => undefined,
			emitExecBridgeToolResult: async () => undefined,
		};
		const sessionRef = { current: session };

		const streams: MockAssistantStream[] = [];
		const handlers: ExecHandlers[] = [];
		const runAOpened = createDeferred();
		const runBOpened = createDeferred();

		// Production wiring: sdk.ts passes the bridge as a per-run factory and the
		// agent loop resolves it with the signal of the run opening the stream.
		const agent: Agent = new Agent({
			cursorExecHandlers: (runSignal: AbortSignal) =>
				createSessionCursorExecBridge(sessionRef, () => agent, runSignal),
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				streams.push(stream);
				handlers.push((options as { execHandlers?: ExecHandlers }).execHandlers ?? {});
				(streams.length === 1 ? runAOpened : runBOpened).resolve();
				return stream;
			},
		});

		const lifecycleEvents: ToolLifecycleEvent[] = [];
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				lifecycleEvents.push(event);
			}
		});

		// given run A is streaming and the loop has handed its stream a bridge
		const runA = agent.prompt("run A");
		await runAOpened.promise;
		const runASignal = agent.signal;
		expect(runASignal).toBeDefined();
		const bridgeA = handlers[0];
		expect(bridgeA.read).toBeDefined();

		// when run A's stream dispatches an exec frame while run A is still live
		const liveResult = await bridgeA.read?.({ path: "a.ts", toolCallId: "live-run-a-frame" });

		// then the tool runs and the frame answers with its output, and the
		// bridge's lifecycle events land on the owning run (issue #992 also
		// routes a tool_result through the session, stubbed here)
		expect(execute).toHaveBeenCalledTimes(1);
		expect(isToolResult(liveResult)).toBe(true);
		expect(isToolResult(liveResult) && liveResult.isError).toBe(false);
		expect(isToolResult(liveResult) && liveResult.content).toEqual([{ type: "text", text: "read ok" }]);
		expect(lifecycleEvents.map((event) => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
		expect(lifecycleEvents.every((event) => event.toolCallId === "live-run-a-frame")).toBe(true);

		// and when run A ends and the fallback lane starts run B
		streams[0].push({ type: "done", reason: "stop", message: createAssistantMessage("run A done") });
		await runA;

		const runB = agent.prompt("run B");
		await runBOpened.promise;
		expect(agent.signal).toBeDefined();
		expect(agent.signal).not.toBe(runASignal);
		lifecycleEvents.length = 0;
		execute.mockClear();

		// then a straggler frame buffered on run A's stream is refused rather than
		// executed against, or leaked into, run B. Post-preflight ownership
		// rechecks (issue #1002) surface as an error tool_execution_end, so assert
		// on the tool and the transcript, not merely on event silence.
		const lateResult = await bridgeA.read?.({ path: "a.ts", toolCallId: "late-run-a-frame" });

		expect(execute).not.toHaveBeenCalled();
		expect(isToolResult(lateResult) && lateResult.isError).toBe(true);
		expect(isToolResult(lateResult) && lateResult.content).toEqual([
			{ type: "text", text: "Tool execution has no active run" },
		]);
		expect(lifecycleEvents.filter((event) => event.type === "tool_execution_end" && !event.isError)).toEqual([]);

		streams[1].push({ type: "done", reason: "stop", message: createAssistantMessage("run B done") });
		await runB;
	});
});
