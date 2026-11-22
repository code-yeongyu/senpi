import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import { renderSchemaHint } from "../src/bridges/schema-hint.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { errorResult, FakeKernel, FakeManager, fakeExtensionContext } from "./eval/fakes.ts";

type ToolResult = AgentToolResult<unknown>;

/** Regression: session 019fa35f abandoned eval after a schema-less validation error. */
const BATCH_TOOL = {
	name: "mcp_computer_use_batch",
	description: "Run 1-20 canonical steps.",
	parameters: {
		type: "object",
		properties: {
			steps: {
				type: "array",
				description: "Canonical steps to run in order.",
				items: {
					type: "object",
					properties: { tool: { type: "string" }, input: { type: "object" } },
					required: ["tool"],
				},
			},
			app: { type: "string", description: "Target application." },
		},
		required: ["steps"],
	},
} as const;

function replyErrorText(kernel: FakeKernel): string {
	const reply = kernel.replies.at(-1);
	if (typeof reply !== "object" || reply === null || !("error" in reply)) return "";
	const error = reply.error;
	if (typeof error !== "object" || error === null || !("message" in error)) return "";
	return String(error.message);
}

function runFailingCall(
	toolName: string,
	listTools?: () => readonly (typeof BATCH_TOOL)[],
	failure: Error = new Error(
		`Validation failed for tool "${toolName}":\n  - steps: must have required properties steps`,
	),
) {
	const kernel = new FakeKernel([
		{ type: "tool-call", callId: "call-1", toolName, args: { app: "Safari" } },
		errorResult("cell-1", "tool call failed"),
	]);
	const executeTool = Object.assign(
		vi.fn(async (): Promise<ToolResult> => {
			throw failure;
		}),
		{ isToolAvailable: () => true },
	);
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 30,
		executeTool,
		...(listTools === undefined ? {} : { listTools }),
	});
	return { kernel, tool };
}

describe("kernel tool-call argument failures", () => {
	it("appends the tool parameter schema resolved from the live catalog", async () => {
		const { kernel, tool } = runFailingCall("mcp_computer_use_batch", () => [BATCH_TOOL]);

		await tool.execute(
			"cell-1",
			{ language: "js", code: 'await tool.mcp_computer_use_batch({app: "Safari"})', summary: "hint catalog" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		const message = replyErrorText(kernel);
		expect(message).toContain("must have required properties steps");
		expect(message).toContain("Expected parameters:");
		expect(message).toContain("required: steps");
		expect(message).toContain("steps: array<object>");
		expect(message).toContain("tool: string");
	});

	it("leaves the message untouched when the tool is not in the catalog", async () => {
		const { kernel, tool } = runFailingCall("unlisted_tool", () => [BATCH_TOOL]);

		await tool.execute(
			"cell-1",
			{ language: "js", code: "await tool.unlisted_tool({})", summary: "hint passthrough" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(replyErrorText(kernel)).not.toContain("Expected parameters:");
	});
});

function executeToolFailure(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

describe("kernel tool-call denials (senpi#2700)", () => {
	it("delivers a blocked call's denial without the parameter schema", async () => {
		const denial = "The user rejected permission to use this specific tool call.";
		const { kernel, tool } = runFailingCall(
			"mcp_computer_use_batch",
			() => [BATCH_TOOL],
			executeToolFailure("blocked", denial),
		);

		await tool.execute(
			"cell-1",
			{ language: "js", code: 'await tool.mcp_computer_use_batch({app: "Safari"})', summary: "denied call" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(replyErrorText(kernel)).toBe(denial);
	});

	it("still appends the parameter schema to an invalid-arguments failure", async () => {
		const { kernel, tool } = runFailingCall(
			"mcp_computer_use_batch",
			() => [BATCH_TOOL],
			executeToolFailure("invalid_params", "steps: must have required properties steps"),
		);

		await tool.execute(
			"cell-1",
			{ language: "js", code: 'await tool.mcp_computer_use_batch({app: "Safari"})', summary: "bad arguments" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		const message = replyErrorText(kernel);
		expect(message).toContain("must have required properties steps");
		expect(message).toContain("Expected parameters:");
	});
});

describe("renderSchemaHint", () => {
	it("renders required properties before optional ones", () => {
		const rendered = renderSchemaHint("t", {
			type: "object",
			properties: { optional: { type: "string" }, needed: { type: "number" } },
			required: ["needed"],
		});

		const lines = String(rendered).split("\n");
		expect(lines.findIndex((line) => line.includes("needed"))).toBeLessThan(
			lines.findIndex((line) => line.includes("optional")),
		);
	});

	it("renders const, unions and caps long enums", () => {
		const rendered = String(
			renderSchemaHint("t", {
				type: "object",
				properties: {
					kind: { const: "batch" },
					mode: { enum: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] },
					either: { oneOf: [{ type: "string" }, { type: "number" }] },
				},
			}),
		);

		expect(rendered).toContain('kind?: "batch"');
		expect(rendered).toContain("2 more)");
		expect(rendered).toContain("either?: string | number");
	});

	it("stays within the character budget and names tool_schema when truncated", () => {
		const properties: Record<string, unknown> = {};
		for (let index = 0; index < 60; index++) {
			properties[`property_${index}`] = { type: "string", description: "x".repeat(70) };
		}
		const rendered = String(renderSchemaHint("big_tool", { type: "object", properties }));

		expect(rendered.length).toBeLessThanOrEqual(1_200);
		expect(rendered).toContain('[truncated; call tool_schema("big_tool") for the full schema]');
	});
});
