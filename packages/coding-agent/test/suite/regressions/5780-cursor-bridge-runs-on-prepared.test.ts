import {
	Agent,
	type AgentEvent,
	type AgentTool,
	type ExecutionPipelineWitness,
	openMemoryBatchStore,
} from "@earendil-works/pi-agent-core";
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
 * Issue #5780: a call Cursor resolves over its exec channel runs on the prepared executor like a model-issued call,
 * so it writes its own `prepared` witness receipt. Wired as production wires it (sdk.ts registers the bridge as a
 * per-run factory on a real Agent).
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

function doneMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
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

type ExecHandlers = { read?: (args: unknown) => Promise<unknown> };

describe("cursor exec bridge on the prepared pipeline (issue #5780)", () => {
	it("writes one prepared receipt per resolved call and keeps the session hooks and lifecycle events", async () => {
		const execute = vi.fn();
		const read = {
			name: "read",
			label: "read",
			description: "stub read",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => {
				execute();
				return { content: [{ type: "text", text: "read ok" }], details: undefined };
			},
		} as unknown as AgentTool;
		const preflight = vi.fn(async () => undefined);
		const toolResults = vi.fn(async () => undefined);
		const session: CursorExecBridgeSession = {
			getRegisteredTool: (name) => (name === "read" ? read : undefined),
			preflightToolCall: preflight,
			emitExecBridgeToolResult: toolResults,
		};
		const receipts: ExecutionPipelineWitness[] = [];
		let handlers: ExecHandlers = {};
		let stream: MockAssistantStream | undefined;
		let opened!: () => void;
		const streamOpened = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const agent: Agent = new Agent({
			batchStoreFactory: openMemoryBatchStore,
			onExecutionPipeline: (witness) => {
				receipts.push(witness);
			},
			cursorExecHandlers: (runSignal: AbortSignal) =>
				createSessionCursorExecBridge({ current: session }, () => agent, runSignal),
			streamFn: (_model, _context, options) => {
				stream = new MockAssistantStream();
				handlers = (options as { execHandlers?: ExecHandlers }).execHandlers ?? {};
				opened();
				return stream;
			},
		});
		const lifecycle: AgentEvent["type"][] = [];
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") lifecycle.push(event.type);
		});

		const run = agent.prompt("read it");
		await streamOpened;
		const result = (await handlers.read?.({ path: "a.ts", toolCallId: "cursor-read-1" })) as ToolResultMessage;
		stream?.push({ type: "done", reason: "stop", message: doneMessage() });
		await run;

		expect(receipts).toEqual([{ pipeline: "prepared", toolCallId: "cursor-read-1" }]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			role: "toolResult",
			toolCallId: "cursor-read-1",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "read ok" }],
		});
		expect(preflight).toHaveBeenCalledTimes(1);
		expect(toolResults).toHaveBeenCalledTimes(1);
		expect(lifecycle).toEqual(["tool_execution_start", "tool_execution_end"]);
	});
});
