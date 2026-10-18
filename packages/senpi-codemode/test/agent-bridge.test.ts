import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import { RESERVED_AGENT_TOOL } from "../src/bridge/reserved.ts";
import { runReservedTool } from "../src/bridges/reserved-dispatch.ts";
import type { EvalSchemaToolInfo } from "../src/bridges/schema-bridge.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { marshalToolResult } from "../src/tool/image.ts";
import type { EvalStatusEvent, ExecuteTool } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";
import { invokeAgent, textResult, withAvailability } from "./workpool/agent-harness.ts";
import { malformedHandles } from "./workpool/handle-fixtures.ts";

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
				options?.onUpdate?.(textResult("starting", { task_id: "st_abcd", run_epoch: 0, status: "running" }));
				options?.onUpdate?.(textResult("done", { task_id: "st_abcd", run_epoch: 0, status: "completed" }));
				return textResult("FAKE_RESULT", { task_id: "st_abcd", run_epoch: 0, status: "completed" });
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
			{ language: "js", code: "await agent('summarize x')", summary: "spawn summarizer" },
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
		expect(evalResult.details.statusEvents).toEqual([{ op: "agent", id: "st_abcd", status: "completed" }]);
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
			{ language: "js", code: "agent('')", summary: "invalid agent call" },
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
				return textResult("Other st_deadbeef before st_abcdef", {
					task_id: "st_123abc",
					run_epoch: 3,
					status: "running",
				});
			},
			() => true,
		);

		// When
		const value = await invokeAgent({ prompt: "x", handle: true }, { executeTool });

		// Then
		expect(params).toEqual({ prompt: "x", run_in_background: true });
		expect(value).toEqual({
			text: "Other st_deadbeef before st_abcdef",
			id: "st_123abc",
			handle: "agent://st_123abc",
			run_epoch: 3,
		});
	});

	it.each(malformedHandles)("rejects malformed legacy handle details %j without prose fallback", async (details) => {
		// Given: several plausible prose IDs must never become a successful handle.
		const executeTool = withAvailability(
			async () => textResult("Started st_deadbeef; related st_abcdef", details),
			() => true,
		);
		// When / Then
		await expect(invokeAgent({ prompt: "x", handle: true }, { executeTool })).rejects.toMatchObject({
			code: "invalid_task_handle",
		});
	});

	it("rejects misleading-success task errors even with valid typed identity", async () => {
		const executeTool = withAvailability(
			async () => ({ ...textResult("Started st_123abc", { task_id: "st_123abc", run_epoch: 0, isError: true }) }),
			() => true,
		);
		await expect(invokeAgent({ prompt: "x", handle: true }, { executeTool })).rejects.toMatchObject({
			code: "invalid_task_handle",
		});
	});

	it("synthesizes defensive progress events from known and unknown details", async () => {
		// Given
		const events: EvalStatusEvent[] = [];
		const executeTool = withAvailability(
			async (_toolName, _params, options) => {
				options?.onUpdate?.(textResult("tick", {}));
				options?.onUpdate?.(
					textResult("done", { task_id: "st_cdef", run_epoch: 1, status: "completed", subagent_type: "reviewer" }),
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
			{ op: "agent", id: "st_cdef", status: "completed", agent: "reviewer" },
		]);
	});

	it("forwards requested kernel tool names and still denies unknown arguments", async () => {
		const calls: unknown[] = [];
		const executeTool = withAvailability(
			async (_toolName, params) => {
				calls.push(params);
				return textResult("ok");
			},
			() => true,
		);
		await expect(invokeAgent({ prompt: "x", extra: true }, { executeTool })).rejects.toThrow(
			"agent() received invalid arguments",
		);
		await expect(invokeAgent({ prompt: "x", tools: ["lookup", "pair"] }, { executeTool })).resolves.toEqual({
			text: "ok",
		});
		expect(calls).toEqual([{ prompt: "x", run_in_background: false, tools: ["lookup", "pair"] }]);
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

	// senpi#1910: probe the same catalog used by tool_schema(), not a host-name assumption.
	it.each([
		[true, "branch"],
		[false, "patch"],
		["branch", "branch"],
		["patch", "patch"],
	])("forwards advertised isolation and normalizes merge %j", async (merge, normalized) => {
		const executeTool = vi.fn(async () => textResult("ok"));
		const listTools = vi.fn(() => [
			{ name: "task", parameters: { properties: {} } },
			{ name: "lane_task", parameters: { properties: { isolated: { type: "boolean" } } } },
		]);
		const events: EvalStatusEvent[] = [];
		const invoke = catalogAgent(executeTool, listTools, events);
		await invoke({ prompt: "x", isolated: true, apply: false, merge });
		expect(executeTool.mock.calls).toEqual([
			[
				"lane_task",
				{ prompt: "x", run_in_background: false, isolated: true, apply: false, merge: normalized },
				expect.any(Object),
			],
		]);
		await invoke({ prompt: "x", isolated: false });
		expect(executeTool).toHaveBeenLastCalledWith(
			"lane_task",
			{ prompt: "x", run_in_background: false, isolated: false },
			expect.any(Object),
		);
		expect(listTools).toHaveBeenCalledTimes(1);
		expect(events).toEqual([]);
	});

	it.each([undefined, {}, { properties: {} }, { properties: { apply: {}, merge: {} } }])(
		"omits isolation when the selected host schema does not advertise it: %j",
		async (parameters) => {
			const executeTool = vi.fn(async () => textResult("ok"));
			const events: EvalStatusEvent[] = [];
			const invoke = catalogAgent(
				executeTool,
				() => [
					{ name: "task", parameters: { properties: { isolated: {} } } },
					{ name: "lane_task", parameters },
				],
				events,
			);
			await invoke({ prompt: "x", isolated: true, apply: false, merge: true });
			expect(executeTool).toHaveBeenCalledWith(
				"lane_task",
				{ prompt: "x", run_in_background: false },
				expect.any(Object),
			);
			expect(events).toHaveLength(1);
			expect(events[0]).toHaveProperty("warning");
		},
	);

	it.each([{}, { schema: { type: "object" } }])("rejects unapplied foreground isolation for %j", async (options) => {
		const isolation = {
			changes_applied: false,
			patch_path: "/artifacts/task.patch",
			branch_name: "isolation/task",
			manual_command: "git apply /artifacts/task.patch",
		};
		const executeTool = async () => textResult('{"answer":42}', { isolation });
		const pending = invokeAgent({ prompt: "x", ...options }, { executeTool });
		await expect(pending).rejects.toMatchObject({
			name: "AgentIsolationNotAppliedError",
			code: "isolation_not_applied",
		});
		for (const field of ["patch_path", "branch_name", "manual_command"] as const) {
			await expect(pending).rejects.toThrow(`${field}: ${isolation[field]}`);
		}
	});

	it.each([true, null])(
		"preserves foreground isolation metadata when changes_applied is %j",
		async (changes_applied) => {
			const isolation = {
				changes_applied,
				patch_path: "/artifacts/task.patch",
				nested_patch_paths: ["nested.patch"],
			};
			const executeTool = async () => textResult('{"answer":42}', { isolation });
			await expect(invokeAgent({ prompt: "x" }, { executeTool })).resolves.toEqual({
				text: '{"answer":42}',
				details: { isolation },
			});
			await expect(invokeAgent({ prompt: "x", schema: {} }, { executeTool })).resolves.toEqual({
				text: '{"answer":42}',
				data: { answer: 42 },
				details: { isolation },
			});
		},
	);

	it("preserves supplied handle isolation without treating it as a foreground completion", async () => {
		const isolation = { changes_applied: false, patch_path: "/artifacts/task.patch" };
		const executeTool = async () => textResult("started", { task_id: "st_abc", run_epoch: 1, isolation });
		await expect(invokeAgent({ prompt: "x", handle: true }, { executeTool })).resolves.toEqual({
			text: "started",
			id: "st_abc",
			handle: "agent://st_abc",
			run_epoch: 1,
			details: { isolation },
		});
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

function catalogAgent(
	executeTool: ExecuteTool,
	listTools: () => readonly EvalSchemaToolInfo[],
	events: EvalStatusEvent[],
) {
	return async (args: unknown) =>
		await runReservedTool(RESERVED_AGENT_TOOL, {
			callId: "catalog-agent",
			args,
			executeTool,
			taskToolName: "lane_task",
			taskOutputToolName: "task_output",
			listTools,
			signal: undefined,
			emitStatus: (event) => events.push(event),
			marshalToolResult,
		});
}
