import {
	type AfterToolCallResult,
	type AgentEvent,
	type AgentTool,
	type AgentToolResult,
	openMemoryBatchStore,
} from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	type CursorExecBridgeSession,
	createSessionCursorExecBridge,
} from "../../../src/core/cursor-exec-bridge-session.ts";

// omo#12466: an extension's tool_result handler may replace a result (the memory guard does, when a second memory
// identity appears while a recursive listing or search runs). Synthetic names only: no real identity is read.
const FOREIGN_LINE = "late-id/repo/system/persona.md:1: synthetic-foreign-line";
const DENY = "cross-identity memory access denied: synthetic";

function isToolResult(value: unknown): value is ToolResultMessage {
	return typeof value === "object" && value !== null && "role" in value && value.role === "toolResult";
}

const DENIAL: AfterToolCallResult = { content: [{ type: "text", text: DENY }], isError: true, details: {} };

function rig(
	answer: AfterToolCallResult = DENIAL,
	original: AgentToolResult<unknown> = { content: [{ type: "text", text: FOREIGN_LINE }], details: undefined },
) {
	const parameters = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) });
	const grep: AgentTool<typeof parameters> = {
		name: "grep",
		label: "grep",
		description: "grep-shaped fixture",
		parameters,
		execute: async () => original,
	};
	const order: string[] = [];
	const ends: AgentToolResult<unknown>[] = [];
	const session: CursorExecBridgeSession = {
		getRegisteredTool: (name) => (name === "grep" ? grep : undefined),
		preflightToolCall: async () => undefined,
		releaseExecBridgeToolCall: () => undefined,
		// Where the session runs its tool_result chain. The chain's answer is modelled as the replacement the memory
		// guard returns.
		emitExecBridgeToolResult: async () => {
			order.push("tool_result");
			return answer;
		},
	};
	const runSignal = new AbortController().signal;
	const agent = {
		signal: runSignal,
		batchStoreFactory: openMemoryBatchStore,
		executionScope: { id: "test-scope", root: "" },
		async emitExternalEvent(event: AgentEvent) {
			order.push(event.type);
			if (event.type === "tool_execution_end") ends.push(event.result);
		},
	};
	return { bridge: createSessionCursorExecBridge({ current: session }, () => agent, runSignal), order, ends };
}

function textOf(result: unknown): string {
	if (!isToolResult(result)) throw new Error("the exec frame answered no tool result");
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("a tool_result replacement on the Cursor exec path (omo#12466)", () => {
	it("runs the tool_result chain before it reports the end of the execution, as the agent loop does", async () => {
		const { bridge, order } = rig();

		await bridge.grep?.({ toolCallId: "call-1", pattern: "synthetic", path: "/synthetic/memory" } as never);

		expect(order).toEqual(["tool_execution_start", "tool_result", "tool_execution_end"]);
	});

	it("answers the exec frame with the replacement, not with the result it replaced", async () => {
		const { bridge } = rig();

		const text = textOf(
			await bridge.grep?.({ toolCallId: "call-2", pattern: "synthetic", path: "/synthetic/memory" } as never),
		);

		expect.soft(text).not.toContain("synthetic-foreign-line");
		expect.soft(text).toContain(DENY);
	});

	it("drops the replaced result's image parts and structured content along with its text", async () => {
		const { bridge, ends } = rig(DENIAL, {
			content: [
				{ type: "text", text: FOREIGN_LINE },
				{ type: "image", data: "c3ludGhldGlj", mimeType: "image/png" },
			],
			structuredContent: { files: [FOREIGN_LINE] },
			details: { matches: [FOREIGN_LINE] },
		});

		const frame = await bridge.grep?.({ toolCallId: "call-3", pattern: "synthetic", path: "/synthetic" } as never);

		expect(frame).toMatchObject({ content: [{ type: "text", text: DENY }], isError: true });
		expect((frame as ToolResultMessage).details).toEqual({});
		expect(ends).toHaveLength(1);
		expect(ends[0]?.structuredContent).toBeUndefined();
		expect(JSON.stringify({ frame, ends })).not.toContain("synthetic-foreign-line");
	});

	it.each([
		{ name: "isError only", answer: { isError: true }, isError: true, details: { matches: 1 } },
		{ name: "details only", answer: { details: {} }, isError: false, details: {} },
	])("applies a partial override ($name) and keeps the fields it leaves out", async ({ answer, isError, details }) => {
		const { bridge } = rig(answer, {
			content: [{ type: "text", text: "synthetic own line" }],
			details: { matches: 1 },
		});

		const frame = await bridge.grep?.({ toolCallId: "call-4", pattern: "synthetic", path: "/synthetic" } as never);

		expect(frame).toMatchObject({ content: [{ type: "text", text: "synthetic own line" }], isError });
		expect((frame as ToolResultMessage).details).toEqual(details);
	});
});
