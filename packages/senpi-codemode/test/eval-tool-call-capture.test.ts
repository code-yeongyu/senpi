import type { AgentToolResult, AgentToolUpdateCallback } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import type { EvalSchemaToolInfo } from "../src/bridges/schema-bridge.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { ExecuteTool } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function createTool(kernel: FakeKernel, executeTool: ExecuteTool, listTools?: () => readonly EvalSchemaToolInfo[]) {
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 30,
		executeTool,
		...(listTools === undefined ? {} : { listTools }),
	});
}

describe("eval tool-call capture", () => {
	it("capture: enriches successful generic calls with bounded arguments and a result preview", async () => {
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "c1", toolName: "read", args: { path: "/tmp/x" } },
			result("capture-success", "done"),
		]);
		const executeTool: ExecuteTool = vi.fn(async () => textResult("file contents"));

		const toolResult = await createTool(kernel, executeTool).execute(
			"capture-success",
			{ language: "js", code: "await tool.read({ path: '/tmp/x' })", summary: "capture success" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(toolResult.details.toolCalls[0]).toMatchObject({
			name: "read",
			ok: true,
			callId: "c1",
			args: { path: "/tmp/x" },
			resultPreview: "file contents",
		});
		expect(toolResult.details.toolCalls[0]?.durationMs).toEqual(expect.any(Number));
	});

	it("capture: records error-bit results without a success preview", async () => {
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "c2", toolName: "bash", args: { command: "exit 1" } },
			result("capture-error-bit", "done"),
		]);
		const executeTool: ExecuteTool = vi.fn(async () =>
			textResult("Command exited with code 1\n...tail", { isError: true }),
		);

		const toolResult = await createTool(kernel, executeTool).execute(
			"capture-error-bit",
			{ language: "js", code: "await tool.bash({ command: 'exit 1' })", summary: "capture error bit" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(toolResult.details.toolCalls[0]).toMatchObject({
			name: "bash",
			ok: false,
			callId: "c2",
			args: { command: "exit 1" },
		});
		expect(toolResult.details.toolCalls[0]?.durationMs).toEqual(expect.any(Number));
		expect(toolResult.details.toolCalls[0]?.error).toContain("exited with code 1");
		expect(toolResult.details.toolCalls[0]).not.toHaveProperty("resultPreview");
	});

	it("capture: preserves rejected execution errors with captured call metadata", async () => {
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "c3", toolName: "blocked", args: { path: "/tmp/blocked" } },
			result("capture-rejection", "done"),
		]);
		const executeTool: ExecuteTool = vi.fn(async () => {
			throw new Error("execution rejected");
		});

		const toolResult = await createTool(kernel, executeTool).execute(
			"capture-rejection",
			{ language: "js", code: "await tool.blocked({ path: '/tmp/blocked' })", summary: "capture rejection" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(toolResult.details.toolCalls[0]).toMatchObject({
			name: "blocked",
			ok: false,
			callId: "c3",
			args: { path: "/tmp/blocked" },
			error: "execution rejected",
		});
		expect(toolResult.details.toolCalls[0]?.durationMs).toEqual(expect.any(Number));
	});

	it("capture: keeps reserved schema calls in the legacy summary shape", async () => {
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "c4", toolName: "__schema__", args: {} },
			result("capture-reserved", "done"),
		]);
		const executeTool: ExecuteTool = vi.fn(async () => textResult("unused"));

		const toolResult = await createTool(kernel, executeTool, () => []).execute(
			"capture-reserved",
			{ language: "js", code: "await tool.__schema__({})", summary: "capture reserved" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(toolResult.details.toolCalls).toEqual([{ name: "__schema__", ok: true }]);
	});

	it("capture: limits enrichment to the first thirty generic calls", async () => {
		const messages: KernelToHostMessage[] = [];
		for (let index = 1; index <= 31; index += 1) {
			messages.push({ type: "tool-call", callId: `c${index}`, toolName: "read", args: { index } });
		}
		messages.push(result("capture-cap", "done"));
		const kernel = new FakeKernel(messages);
		const executeTool: ExecuteTool = vi.fn(async () => textResult("ok"));

		const toolResult = await createTool(kernel, executeTool).execute(
			"capture-cap",
			{ language: "js", code: "many calls", summary: "capture cap" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(toolResult.details.toolCalls).toHaveLength(31);
		expect(
			toolResult.details.toolCalls
				.slice(0, 30)
				.every(
					(summary) =>
						summary.callId !== undefined &&
						summary.args !== undefined &&
						typeof summary.durationMs === "number" &&
						summary.resultPreview === "ok",
				),
		).toBe(true);
		expect(toolResult.details.toolCalls[30]).toMatchObject({
			name: "read",
			ok: true,
			durationMs: expect.any(Number),
		});
	});

	it("capture: streams an enriched summary before finalization", async () => {
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "c5", toolName: "read", args: { path: "/tmp/live" } },
			result("capture-stream", "done"),
		]);
		const executeTool: ExecuteTool = vi.fn(async () => textResult("live contents"));
		const updates: unknown[] = [];
		const onUpdate: AgentToolUpdateCallback = (update) => {
			updates.push(update);
		};

		await createTool(kernel, executeTool).execute(
			"capture-stream",
			{ language: "js", code: "await tool.read({ path: '/tmp/live' })", summary: "capture stream" },
			undefined,
			onUpdate,
			fakeExtensionContext(),
		);

		expect(updates).toContainEqual(
			expect.objectContaining({
				details: expect.objectContaining({
					cells: [expect.objectContaining({ status: "running" })],
					toolCalls: [
						expect.objectContaining({
							name: "read",
							callId: "c5",
							args: { path: "/tmp/live" },
							resultPreview: "live contents",
						}),
					],
				}),
			}),
		);
	});
});
