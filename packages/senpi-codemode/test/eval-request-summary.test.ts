import { type JsonObject, type JsonValue, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { isEvalControlRequest, normalizeEvalSummary, parseEvalRequest } from "../src/tool/eval-request.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalToolInput } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

const TEACHING_ERROR =
	"eval run requires summary — one line in the user's language: what you are working on and for what purpose";
const SUMMARY_SCHEMA_DESCRIPTION =
	"REQUIRED for run. One line in the language the user writes in: a progress update saying what you are doing and why, not a label for the code; shown in the TUI while the cell runs.";
const LONG_SUMMARY = "s".repeat(300);

type EvalTool = ReturnType<typeof createEvalTool>;

function buildTool(): EvalTool {
	const kernel = new FakeKernel([result("cell-1", "1", 1)]);
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
	});
}

function parseRun(params: unknown): EvalToolInput {
	const parsed = parseEvalRequest(params);
	if (isEvalControlRequest(parsed)) throw new Error("expected a run request");
	return parsed;
}

function parseError(params: unknown): TypeError {
	try {
		parseEvalRequest(params);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return error;
	}
	throw new Error("expected parseEvalRequest to throw");
}

function prepareEvalArguments(tool: EvalTool, args: unknown): Record<string, unknown> {
	const prepare = tool.prepareArguments;
	if (prepare === undefined) throw new Error("eval tool must define prepareArguments");
	return { ...prepare(args) };
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		return true;
	if (Array.isArray(value)) return value.every(isJsonValue);
	return typeof value === "object" && Object.values(value).every(isJsonValue);
}

function isJsonObject(value: Record<string, unknown>): value is JsonObject {
	return Object.values(value).every(isJsonValue);
}

function validatePrepared(tool: EvalTool, prepared: Record<string, unknown>): Record<string, unknown> {
	// Tool-call arguments are parsed JSON on the real path (ToolCall.arguments is a JsonObject).
	if (!isJsonObject(prepared)) throw new Error("prepared eval arguments are not JSON");
	const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "eval", arguments: prepared };
	return validateToolArguments(tool, toolCall);
}

describe("normalizeEvalSummary", () => {
	it("returns undefined for non-string values", () => {
		expect(normalizeEvalSummary(undefined)).toBeUndefined();
		expect(normalizeEvalSummary(null)).toBeUndefined();
		expect(normalizeEvalSummary(42)).toBeUndefined();
		expect(normalizeEvalSummary(true)).toBeUndefined();
		expect(normalizeEvalSummary({})).toBeUndefined();
	});

	it("trims and collapses internal whitespace", () => {
		expect(normalizeEvalSummary("  a   b  ")).toBe("a b");
		expect(normalizeEvalSummary("a\n\tb   c")).toBe("a b c");
	});

	it("returns undefined for empty or whitespace-only values", () => {
		expect(normalizeEvalSummary("")).toBeUndefined();
		expect(normalizeEvalSummary("   ")).toBeUndefined();
	});

	it("keeps a long value whole", () => {
		expect(normalizeEvalSummary(LONG_SUMMARY)).toBe(LONG_SUMMARY);
	});
});

describe("parseEvalRequest summary enforcement", () => {
	it("throws the teaching error when a run omits summary", () => {
		expect(parseError({ language: "py", code: "print(1)" }).message).toBe(TEACHING_ERROR);
	});

	it("throws the teaching error when a run summary is empty, blank, or non-string", () => {
		expect(parseError({ language: "py", code: "print(1)", summary: "" }).message).toBe(TEACHING_ERROR);
		expect(parseError({ language: "py", code: "print(1)", summary: "   " }).message).toBe(TEACHING_ERROR);
		expect(parseError({ language: "py", code: "print(1)", summary: 42 }).message).toBe(TEACHING_ERROR);
	});

	it("throws the teaching error for an explicit run action without summary", () => {
		expect(parseError({ action: "run", language: "py", code: "print(1)" }).message).toBe(TEACHING_ERROR);
	});

	it("passes through summaries within the limit", () => {
		const parsed = parseRun({ language: "py", code: "print(1)", summary: "집계 셀 실행" });
		expect(parsed.summary).toBe("집계 셀 실행");
	});

	it("collapses whitespace in summaries", () => {
		expect(parseRun({ language: "py", code: "print(1)", summary: "  a   b  " }).summary).toBe("a b");
	});

	it("keeps a long summary untruncated", () => {
		expect(parseRun({ language: "py", code: "print(1)", summary: LONG_SUMMARY }).summary).toBe(LONG_SUMMARY);
	});

	it("accepts peek and stop without a summary and ignores a provided one", () => {
		expect(parseEvalRequest({ action: "peek", cell_id: "cell-1" })).toEqual({ action: "peek", cell_id: "cell-1" });
		expect(parseEvalRequest({ action: "stop", cell_id: "cell-1" })).toEqual({ action: "stop", cell_id: "cell-1" });
		expect(parseEvalRequest({ action: "peek", cell_id: "cell-1", summary: "ignored" })).toEqual({
			action: "peek",
			cell_id: "cell-1",
		});
	});

	it("parses legacy title-bearing runs with title absent from the result", () => {
		const parsed = parseRun({ title: "legacy label", summary: "kept summary", language: "py", code: "print(1)" });
		expect(parsed).toEqual({ language: "py", code: "print(1)", summary: "kept summary" });
		expect("title" in parsed).toBe(false);
	});
});

describe("eval tool schema", () => {
	it("describes summary with the verbatim required-for-run guide and no length limit", () => {
		const tool = buildTool();
		const properties: unknown = tool.parameters.properties;
		if (typeof properties !== "object" || properties === null || !("summary" in properties))
			throw new Error("the eval schema has no summary field");
		const raw: unknown = Object.getOwnPropertyDescriptor(properties, "summary")?.value;
		if (typeof raw !== "object" || raw === null) throw new Error("the eval schema's summary field is not an object");
		const description: unknown = Object.getOwnPropertyDescriptor(raw, "description")?.value;
		const maxLength: unknown = Object.getOwnPropertyDescriptor(raw, "maxLength")?.value;
		const summary = {
			description: typeof description === "string" ? description : undefined,
			maxLength: typeof maxLength === "number" ? maxLength : undefined,
		};
		expect(summary.description).toContain(SUMMARY_SCHEMA_DESCRIPTION);
		expect(summary.maxLength).toBeUndefined();
	});

	it("removes title from the input schema", () => {
		const tool = buildTool();
		expect("title" in tool.parameters.properties).toBe(false);
	});
});

describe("eval tool prepareArguments", () => {
	it("keeps a long summary whole through preparation and schema validation", () => {
		const tool = buildTool();
		const prepared = prepareEvalArguments(tool, { language: "js", code: "return 1", summary: LONG_SUMMARY });
		expect(prepared.summary).toBe(LONG_SUMMARY);
		expect(validatePrepared(tool, prepared).summary).toBe(LONG_SUMMARY);
	});

	it("drops an empty summary instead of failing validation", () => {
		const tool = buildTool();
		const prepared = prepareEvalArguments(tool, { language: "js", code: "return 1", summary: "   " });
		expect("summary" in prepared).toBe(false);
	});

	it("passes peek and stop arguments through untouched", () => {
		const tool = buildTool();
		const prepared = prepareEvalArguments(tool, { action: "peek", cell_id: "cell-9", summary: "  padded  " });
		expect(prepared).toEqual({ action: "peek", cell_id: "cell-9", summary: "  padded  " });
	});

	it("keeps legacy title props and still validates", () => {
		const tool = buildTool();
		const prepared = prepareEvalArguments(tool, {
			language: "js",
			code: "return 1",
			summary: "legacy caller",
			title: "old label",
		});
		expect(prepared.title).toBe("old label");
		const validated = validatePrepared(tool, prepared);
		expect(validated.title).toBe("old label");
		expect(validated.summary).toBe("legacy caller");
	});
});

describe("eval tool execute error path", () => {
	it("surfaces the teaching error as a tool error when summary is missing", async () => {
		const tool = buildTool();
		const call = tool.execute(
			"cell-1",
			{ language: "js", code: "return 42" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		await expect(call).rejects.toThrowError(TypeError);
		await expect(call).rejects.toThrow(TEACHING_ERROR);
	});
});
