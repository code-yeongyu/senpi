import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ReportedToolResultOutcome } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#7232: a tool that already did the work (a codemode cell that wrote a file itself) could not run the hooks a
// write call triggers without writing the file a second time through the whole tool pipeline.
describe("ctx.reportToolResult (senpi#7232)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs the tool_result handlers for the reported result, marked as issued by the calling tool, and runs no tool", async () => {
		const toolCalls: string[] = [];
		const results: Array<{ toolName: string; toolCallId: string; parentToolCallId?: string; path: unknown }> = [];
		let outcome: ReportedToolResultOutcome | undefined;
		let reportedPath = "";
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						toolCalls.push(event.toolName);
					});
					pi.on("tool_result", (event) => {
						if (event.toolName === "write") throw new Error("formatter crashed");
					});
				},
				(pi) => {
					pi.on("tool_result", (event) => {
						results.push({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
							path: event.input.path,
						});
						if (event.toolName !== "write" || event.isError) return undefined;
						return { content: [...event.content, { type: "text", text: `diagnostics for ${event.input.path}` }] };
					});
					pi.registerTool({
						name: "outer",
						label: "Outer",
						description: "Reports a file it wrote on its own",
						parameters: Type.Object({}),
						async execute(_toolCallId, _input, _signal, _onUpdate, ctx) {
							outcome = await ctx.reportToolResult({
								toolName: "write",
								input: { path: reportedPath, content: "export {};\n" },
								content: [{ type: "text", text: `Successfully wrote to ${reportedPath}` }],
							});
							return { content: [{ type: "text", text: "reported" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		reportedPath = join(harness.tempDir, "never-written.ts");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("outer", {}, { id: "outer-call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run outer");

		expect(results.filter((result) => result.toolName === "write")).toEqual([
			{
				toolName: "write",
				toolCallId: "outer-call/reported-1",
				parentToolCallId: "outer-call",
				path: reportedPath,
			},
		]);
		expect(outcome).toEqual({
			toolCallId: "outer-call/reported-1",
			result: expect.objectContaining({
				content: [
					{ type: "text", text: `Successfully wrote to ${reportedPath}` },
					{ type: "text", text: `diagnostics for ${reportedPath}` },
				],
			}),
			failures: [{ extensionPath: expect.any(String), error: "formatter crashed" }],
		});
		expect(toolCalls).toEqual(["outer"]);
		expect(existsSync(reportedPath)).toBe(false);
	});
});
