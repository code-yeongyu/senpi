import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { type CursorExecBridgeSession, createSessionCursorExecBridge } from "../src/core/cursor-exec-bridge-session.ts";
import { createLoopGuardHarness, isRecord } from "./suite/loop-guard-test-harness.ts";

function isToolResult(value: unknown): value is ToolResultMessage {
	return typeof value === "object" && value !== null && "role" in value && value.role === "toolResult";
}

describe("cursor exec bridge tool_call preflight", () => {
	it("returns loop-guard blocks for identical attempts 7-9 without executing them", async () => {
		const harness = createLoopGuardHarness();
		const parameters = Type.Object({ path: Type.String(), content: Type.String() });
		const execute = vi.fn<AgentTool<typeof parameters>["execute"]>(async (_toolCallId, params) => ({
			content: [{ type: "text", text: params.content }],
			details: undefined,
		}));
		const tool: AgentTool<typeof parameters> = {
			name: "write",
			label: "write",
			description: "write test tool",
			parameters,
			execute,
		};
		const events: AgentEvent[] = [];
		let eventQueue = Promise.resolve();
		const session: CursorExecBridgeSession = {
			getRegisteredTool: (name) => (name === "write" ? tool : undefined),
			preflightToolCall: async (toolCall, args) => {
				await eventQueue;
				if (isRecord(args) && "content" in args) args.content = "mutated by tool_call";
				const result = await harness.fire("tool_call", {
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args,
				});
				if (!isRecord(result) || result.block !== true) return undefined;
				return {
					block: true,
					...(typeof result.reason === "string" ? { reason: result.reason } : {}),
					...(result.terminate === true ? { terminate: true } : {}),
				};
			},
		};
		const runSignal = new AbortController().signal;
		const agent = {
			signal: runSignal,
			async emitExternalEvent(event: AgentEvent) {
				events.push(event);
				eventQueue = eventQueue.then(async () => {
					await harness.fire(event.type, event);
				});
			},
		};
		const bridge = createSessionCursorExecBridge({ current: session }, () => agent);

		const results: ToolResultMessage[] = [];
		for (let attempt = 1; attempt <= 9; attempt++) {
			const result = await bridge.piWrite?.({
				toolCallId: `call-${attempt}`,
				args: { $typeName: "agent.v1.PiWriteExecArgs", path: "same.ts", content: "same content" },
			});
			expect(isToolResult(result)).toBe(true);
			if (isToolResult(result)) results.push(result);
		}
		await eventQueue;

		expect(execute).toHaveBeenCalledTimes(6);
		expect(execute.mock.calls.map((call) => call[1])).toEqual(
			Array.from({ length: 6 }, () => ({ path: "same.ts", content: "mutated by tool_call" })),
		);
		expect(results.slice(0, 6).every((result) => result.isError === false)).toBe(true);
		expect(results.slice(6).every((result) => result.isError)).toBe(true);
		expect(events.map((event) => event.type)).toEqual(
			Array.from({ length: 9 }, () => ["tool_execution_start", "tool_execution_end"]).flat(),
		);
		expect(harness.actions).toContain("abort:system");
	});
});
