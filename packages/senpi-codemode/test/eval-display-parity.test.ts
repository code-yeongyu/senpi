import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

type ToolContent = AgentToolResult<unknown>["content"][number];
type TextPart = Extract<ToolContent, { type: "text" }>;

function textOf(toolResult: AgentToolResult<unknown>): string {
	return toolResult.content
		.filter((part): part is TextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function createTool(kernel: FakeKernel) {
	return createEvalTool({
		enabledLanguages: { py: false, js: true, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
	});
}

describe("eval display text parity", () => {
	it("Given stdout around a JSON display when the cell settles then model text preserves the event order", async () => {
		const value = { answer: 42 };
		const kernel = new FakeKernel([
			{ type: "text", stream: "stdout", data: "before\n" },
			{
				type: "display",
				mimeType: "application/json",
				dataBase64: Buffer.from(JSON.stringify(value)).toString("base64"),
			},
			{ type: "text", stream: "stdout", data: "after\n" },
			result("display-order", "done"),
		]);

		// When
		const toolResult = await createTool(kernel).execute(
			"display-order",
			{ language: "js", code: "print('before'); display({answer: 42}); print('after')" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then
		const text = textOf(toolResult);
		expect(text.indexOf("before")).toBeLessThan(text.indexOf("display[1]"));
		expect(text.indexOf("display[1]")).toBeLessThan(text.indexOf("after"));
		expect(toolResult.details.jsonOutputs).toEqual([value]);
	});

	it("Given no text or display output when the cell settles then the model receives the no-output marker", async () => {
		const kernel = new FakeKernel([{ type: "result", cellId: "empty", ok: true, durationMs: 1 }]);

		// When
		const toolResult = await createTool(kernel).execute(
			"empty",
			{ language: "js", code: "undefined" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then
		expect(textOf(toolResult)).toBe("(no output)");
	});

	it("Given an oversized JSON display when the cell settles then its model-facing text is bounded", async () => {
		const value = { payload: "x".repeat(20_000) };
		const kernel = new FakeKernel([
			{
				type: "display",
				mimeType: "application/json",
				dataBase64: Buffer.from(JSON.stringify(value)).toString("base64"),
			},
			result("large-display", "done"),
		]);

		// When
		const toolResult = await createTool(kernel).execute(
			"large-display",
			{ language: "js", code: "display(value)" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then
		const text = textOf(toolResult);
		expect(text).toContain("ch elided");
		expect(text.length).toBeLessThan(10_000);
		expect(toolResult.details.jsonOutputs).toEqual([value]);
	});
});
