import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { RESERVED_AGENT_TOOL } from "../src/bridge/reserved.ts";
import { type AgentExecuteTool, type EvalAgentResult, runEvalAgent } from "../src/bridges/agent-bridge.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalStatusEvent, ExecuteTool } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function withAvailability(executeTool: ExecuteTool, isToolAvailable: (name: string) => boolean): AgentExecuteTool {
	return Object.assign(executeTool, { isToolAvailable });
}

type AgentHarness = {
	readonly executeTool: AgentExecuteTool;
	readonly taskToolName?: string;
	readonly signal?: AbortSignal;
	readonly emitStatus?: (event: EvalStatusEvent) => void;
};

function invokeAgent(args: unknown, harness: AgentHarness): Promise<EvalAgentResult> {
	return runEvalAgent(args, {
		callId: "agent-call-1",
		taskToolName: harness.taskToolName ?? "task",
		executeTool: harness.executeTool,
		...(harness.signal ? { signal: harness.signal } : {}),
		...(harness.emitStatus ? { emitStatus: harness.emitStatus } : {}),
	});
}

describe("agent bridge", () => {
	it("delegates the reserved call and coalesces task progress in cell updates", async () => {
		// Given
		const kernel = new FakeKernel([
			{
				type: "tool-call",
				callId: "agent-call-1",
				toolName: RESERVED_AGENT_TOOL,
				args: { prompt: "summarize x", agent: "reviewer" },
			},
			result("cell-1", "done"),
		]);
		const calls: Array<{ readonly toolName: string; readonly params: unknown }> = [];
		const executeTool = withAvailability(
			async (toolName, params, options) => {
				calls.push({ toolName, params });
				options?.onUpdate?.(textResult("starting", { task_id: "st_progress", status: "running" }));
				options?.onUpdate?.(textResult("done", { task_id: "st_progress", status: "completed" }));
				return textResult("FAKE_RESULT", { task_id: "st_progress", status: "completed" });
			},
			(name) => name === "task",
		);
		const tool = createEvalTool({
			enabledLanguages: { py: false, js: true, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool,
		});

		// When
		const evalResult = await tool.execute(
			"cell-1",
			{ language: "js", code: "await agent('summarize x')" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then
		expect(calls).toEqual([
			{ toolName: "task", params: { prompt: "summarize x", subagent_type: "reviewer", run_in_background: false } },
		]);
		expect(kernel.replies).toContainEqual({
			type: "tool-reply",
			callId: "agent-call-1",
			ok: true,
			value: { text: "FAKE_RESULT" },
		});
		expect(evalResult.details.statusEvents).toEqual([{ op: "agent", id: "st_progress", status: "completed" }]);
	});

	it.each([
		["a missing prompt", {}],
		["an empty prompt", { prompt: "" }],
		["an unknown argument", { prompt: "x", extra: true }],
	])("rejects %s", async (_case, args) => {
		// Given
		const executeTool = withAvailability(
			async () => textResult("unused"),
			() => true,
		);

		// When / Then
		await expect(invokeAgent(args, { executeTool })).rejects.toThrow("agent() received invalid arguments");
	});

	it("returns a structured tool reply for invalid kernel arguments", async () => {
		// Given
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "bad-agent", toolName: RESERVED_AGENT_TOOL, args: { prompt: "" } },
			result("cell-invalid", "done"),
		]);
		const executeTool = withAvailability(
			async () => textResult("unused"),
			() => true,
		);
		const tool = createEvalTool({
			enabledLanguages: { py: false, js: true, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool,
		});

		// When
		await tool.execute(
			"cell-invalid",
			{ language: "js", code: "agent('')" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then
		expect(kernel.replies).toContainEqual({
			type: "tool-reply",
			callId: "bad-agent",
			ok: false,
			error: { message: expect.stringContaining("agent() received invalid arguments") },
		});
	});

	it("reports the exact unavailable-tool error without executing the task", async () => {
		// Given
		let executed = false;
		const executeTool = withAvailability(
			async () => {
				executed = true;
				return textResult("unused");
			},
			() => false,
		);

		// When / Then
		await expect(invokeAgent({ prompt: "x" }, { executeTool })).rejects.toThrow(
			'agent() unavailable: no "task" tool is registered in this session',
		);
		expect(executed).toBe(false);
	});

	it("injects a schema, maps task parameters, and parses foreground JSON", async () => {
		// Given
		const calls: Array<{ readonly toolName: string; readonly params: unknown }> = [];
		const executeTool = withAvailability(
			async (toolName, params) => {
				calls.push({ toolName, params });
				return textResult('{"answer":42}');
			},
			(name) => name === "lane_task",
		);

		// When
		const value = await invokeAgent(
			{ prompt: "solve", agent: "reviewer", model: "slow", label: "lane", schema: { type: "object" } },
			{ executeTool, taskToolName: "lane_task" },
		);

		// Then
		expect(calls).toEqual([
			{
				toolName: "lane_task",
				params: {
					prompt: 'solve\n\nRespond ONLY with JSON matching this JSON-Schema:\n{"type":"object"}',
					subagent_type: "reviewer",
					model: "slow",
					name: "lane",
					run_in_background: false,
				},
			},
		]);
		expect(value).toEqual({ text: '{"answer":42}', data: { answer: 42 } });
	});

	it("returns structured parse failure data instead of throwing", async () => {
		// Given
		const executeTool = withAvailability(
			async () => textResult("not json"),
			() => true,
		);

		// When
		const value = await invokeAgent({ prompt: "x", schema: { type: "object" } }, { executeTool });

		// Then
		expect(value).toMatchObject({ text: "not json", parseError: expect.any(String) });
	});

	it("extracts a background handle from task details", async () => {
		// Given
		let params: unknown;
		const executeTool = withAvailability(
			async (_toolName, value) => {
				params = value;
				return textResult("Started task", { task_id: "st_detail_123", status: "running" });
			},
			() => true,
		);

		// When
		const value = await invokeAgent({ prompt: "x", handle: true }, { executeTool });

		// Then
		expect(params).toEqual({ prompt: "x", run_in_background: true });
		expect(value).toEqual({ text: "Started task", id: "st_detail_123", handle: "agent://st_detail_123" });
	});

	it("falls back to extracting a background id from task text", async () => {
		// Given
		const executeTool = withAvailability(
			async () => textResult("Started task st_text_456 (running)"),
			() => true,
		);

		// When
		const value = await invokeAgent({ prompt: "x", handle: true }, { executeTool });

		// Then
		expect(value).toMatchObject({ id: "st_text_456", handle: "agent://st_text_456" });
	});

	it("synthesizes defensive progress events from known and unknown details", async () => {
		// Given
		const events: EvalStatusEvent[] = [];
		const executeTool = withAvailability(
			async (_toolName, _params, options) => {
				options?.onUpdate?.(textResult("tick", {}));
				options?.onUpdate?.(
					textResult("done", { task_id: "st_known", status: "completed", subagent_type: "reviewer" }),
				);
				return textResult("ok");
			},
			() => true,
		);

		// When
		await invokeAgent({ prompt: "x", label: "lane" }, { executeTool, emitStatus: (event) => events.push(event) });

		// Then
		expect(events).toEqual([
			{ op: "agent", id: "lane", status: "running" },
			{ op: "agent", id: "st_known", status: "completed", agent: "reviewer" },
		]);
	});

	it("drops unsupported isolation options and emits their warning", async () => {
		// Given
		const events: EvalStatusEvent[] = [];
		let params: unknown;
		const executeTool = withAvailability(
			async (_toolName, value) => {
				params = value;
				return textResult("ok");
			},
			() => true,
		);

		// When
		await invokeAgent(
			{ prompt: "x", isolated: true, apply: false, merge: true },
			{ executeTool, emitStatus: (event) => events.push(event) },
		);

		// Then
		expect(params).toEqual({ prompt: "x", run_in_background: false });
		expect(events).toEqual([
			{
				op: "agent",
				id: "agent-call-1",
				status: "running",
				warning: "isolated/apply/merge unsupported (no isolation in task engine)",
			},
		]);
	});

	it("propagates the cell abort signal to task execution", async () => {
		// Given
		const controller = new AbortController();
		const executeTool = withAvailability(
			async (_toolName, _params, options) => {
				const signal = options?.signal;
				if (!signal) throw new DOMException("missing signal", "AbortError");
				return await new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
					const rejectAbort = (): void => reject(signal.reason);
					if (signal.aborted) rejectAbort();
					else signal.addEventListener("abort", rejectAbort, { once: true });
				});
			},
			() => true,
		);

		// When
		const pending = invokeAgent({ prompt: "x" }, { executeTool, signal: controller.signal });
		controller.abort(new DOMException("cancelled by caller", "AbortError"));

		// Then
		await expect(pending).rejects.toThrow("cancelled by caller");
	});
});
