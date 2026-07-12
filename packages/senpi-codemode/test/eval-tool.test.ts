import type { AgentToolResult, AgentToolUpdateCallback } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { errorResult, FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

type ToolResult = AgentToolResult<unknown>;
type ToolContent = ToolResult["content"][number];
type TextPart = Extract<ToolContent, { type: "text" }>;
type ImagePart = Extract<ToolContent, { type: "image" }>;
type ExecuteTool = (
	toolName: string,
	params: unknown,
	options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback },
) => Promise<ToolResult>;

function isTextPart(part: ToolContent): part is TextPart {
	return part.type === "text";
}

function textOf(toolResult: ToolResult): string {
	const texts: string[] = [];
	for (const part of toolResult.content) {
		if (isTextPart(part)) texts.push(part.text);
	}
	return texts.join("\n");
}

function imageCount(toolResult: ToolResult): number {
	let count = 0;
	for (const part of toolResult.content) {
		if (isImagePart(part)) count++;
	}
	return count;
}

function isImagePart(part: ToolContent): part is ImagePart {
	return part.type === "image";
}

function updateDetails(update: unknown): unknown {
	if (typeof update === "object" && update !== null && "details" in update) return update.details;
	return undefined;
}

describe("createEvalTool", () => {
	it("builds a dynamic language schema and runs a js cell with streaming details", async () => {
		const kernel = new FakeKernel([
			{ type: "phase", title: "setup" },
			{ type: "text", stream: "stdout", data: "hello\n" },
			result("cell-1", "42", 7),
		]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});
		const updates: unknown[] = [];

		const onUpdate: AgentToolUpdateCallback = (update: Parameters<AgentToolUpdateCallback>[0]) => {
			updates.push(updateDetails(update));
		};

		expect(tool.executionMode).toBe("sequential");
		const toolResult = await tool.execute(
			"cell-1",
			{ language: "js", code: "return 42", title: "math" },
			undefined,
			onUpdate,
			fakeExtensionContext(),
		);

		expect(tool.parameters.properties.language.anyOf).toEqual([{ const: "js", type: "string" }]);
		expect(textOf(toolResult)).toContain("hello");
		expect(textOf(toolResult)).toContain("42");
		expect(toolResult.details).toMatchObject({ language: "js", title: "math", durationMs: 7, truncated: false });
		expect(updates).toContainEqual(expect.objectContaining({ phase: "setup" }));
	});

	it("dispatches kernel tool calls through executeTool and marshals replies back", async () => {
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "call-1", toolName: "demo", args: { x: 1 } },
			result("cell-2", "done"),
		]);
		const bridgeSignals: AbortSignal[] = [];
		const executeTool: ExecuteTool = vi.fn(async (_toolName, _params, options) => {
			if (options?.signal) bridgeSignals.push(options.signal);
			return { content: [{ type: "text" as const, text: "demo ok" }], details: {} };
		});
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: true, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool,
		});

		const toolResult = await tool.execute(
			"cell-2",
			{ language: "js", code: "await tool.demo({x:1})" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(executeTool).toHaveBeenCalledWith("demo", { x: 1 }, expect.objectContaining({ signal: bridgeSignals[0] }));
		expect(bridgeSignals).toHaveLength(1);
		expect(bridgeSignals[0]?.aborted).toBe(true);
		expect(kernel.replies).toContainEqual({
			type: "tool-reply",
			callId: "call-1",
			ok: true,
			value: { text: "demo ok" },
		});
		expect(toolResult.details).toMatchObject({ toolCalls: [{ name: "demo", ok: true }] });
	});

	it("guards recursive eval tool calls without touching executeTool", async () => {
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "call-2", toolName: "eval", args: { language: "js", code: "1" } },
			errorResult("cell-3", "recursive eval is not allowed"),
		]);
		const executeTool = vi.fn();
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool,
		});

		const toolResult = await tool.execute(
			"cell-3",
			{ language: "js", code: "await tool.eval({})" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(executeTool).not.toHaveBeenCalled();
		expect(kernel.replies).toContainEqual({
			type: "tool-reply",
			callId: "call-2",
			ok: false,
			error: { message: "recursive eval is not allowed" },
		});
		expect(toolResult.details).toMatchObject({ isError: true });
	});

	it("reports unknown languages with enabled language names", async () => {
		const tool = createEvalTool({
			enabledLanguages: { js: false, py: true, rb: false, jl: false },
			kernelManager: new FakeManager([]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});

		await expect(
			tool.execute("cell-4", { language: "js", code: "1" }, undefined, undefined, fakeExtensionContext()),
		).rejects.toThrow('Unsupported eval language "js". Enabled languages: py');
	});

	it("honors timeout, reset, truncation, and display images", async () => {
		const big = `${Array.from({ length: 2_010 }, (_, index) => `line-${index}`).join("\n")}\n`;
		const kernel = new FakeKernel([
			{ type: "text", stream: "stdout", data: big },
			{ type: "display", mimeType: "image/png", dataBase64: "abc123" },
			result("cell-5", "tail"),
		]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});

		const toolResult = await tool.execute(
			"cell-5",
			{ language: "js", code: "heavy()", timeout: 2, reset: true },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(kernel.resetCount).toBe(1);
		expect(kernel.runs[0]?.timeoutMs).toBeUndefined();
		expect(toolResult.details).toMatchObject({ truncated: true });
		expect(textOf(toolResult)).toContain("[Output truncated:");
		expect(imageCount(toolResult)).toBe(1);
	});

	it("surfaces blocked executeTool errors without killing the kernel", async () => {
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "call-3", toolName: "blocked", args: {} },
			errorResult("cell-6", "nope"),
		]);
		const executeTool: ExecuteTool = vi.fn(async () => {
			throw new Error("nope");
		});
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool,
		});

		const first = await tool.execute(
			"cell-6",
			{ language: "js", code: "await tool.blocked({})" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		kernel.onMessage = undefined;
		kernel.replaceMessages([result("cell-7", "next-ok")]);
		const second = await tool.execute(
			"cell-7",
			{ language: "js", code: "1 + 1" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(kernel.replies).toContainEqual({
			type: "tool-reply",
			callId: "call-3",
			ok: false,
			error: { message: "nope" },
		});
		expect(first.details).toMatchObject({ isError: true });
		expect(textOf(second)).toContain("next-ok");
	});
});
