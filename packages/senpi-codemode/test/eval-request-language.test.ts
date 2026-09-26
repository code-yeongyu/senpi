import { describe, expect, it, vi } from "vitest";
import { parseEvalRequest } from "../src/tool/eval-request.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalLanguage, EvalToolRequest } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

const LANGUAGE_TEACHING_ERROR = 'eval run requires language — one of "js", "py", "rb", "jl"';
const JS_ONLY_LANGUAGE_TEACHING_ERROR = 'eval run requires language — one of "js"';
const DEFAULT_ENABLED_LANGUAGE_TEACHING_ERROR = 'eval run requires language — one of "js", "py"';
const INVALID_LANGUAGE_ERROR = "eval run language must be one of: js, py, rb, jl";
const CODE_TEACHING_ERROR = "eval run requires code — the cell body to execute, verbatim";
const LANGUAGE_SCHEMA_DESCRIPTION =
	"REQUIRED for run. Kernel that runs the cell; each language keeps its own persistent state across eval calls.";
const CODE_SCHEMA_DESCRIPTION = "REQUIRED for run. Cell body, verbatim.";

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

function parseError(params: unknown, enabledLanguages?: readonly EvalLanguage[]): TypeError {
	try {
		parseEvalRequest(params, enabledLanguages);
	} catch (error) {
		expect(error).toBeInstanceOf(TypeError);
		return error as TypeError;
	}
	throw new Error("expected parseEvalRequest to throw");
}

function languageError(language: unknown): TypeError {
	return parseError({ language, code: "return 1", summary: "Evaluate a number" });
}

describe("eval request language validation", () => {
	it.each([null, "", "python", 42])("distinguishes invalid language %j from an omission", (language) => {
		expect(languageError(language).message).not.toBe(languageError(undefined).message);
	});

	it("rejects an omitted language instead of selecting a default kernel", () => {
		expect(() => parseEvalRequest({ code: "return 1", summary: "Evaluate a number" })).toThrow(TypeError);
	});

	it.each(["peek", "stop"])("accepts %s without a language", (action) => {
		expect(parseEvalRequest({ action, cell_id: "cell-1395" })).toEqual({ action, cell_id: "cell-1395" });
	});
});

describe("parseEvalRequest language and code enforcement", () => {
	it("throws an actionable error when a run omits language", () => {
		expect(parseError({ code: "return 1", summary: "run without a language" }).message).toBe(LANGUAGE_TEACHING_ERROR);
	});

	it("throws a distinct actionable error for an unknown language value", () => {
		expect(
			parseError({ language: "python", code: "print(1)", summary: "run with an unknown language" }).message,
		).toBe(INVALID_LANGUAGE_ERROR);
	});

	it("names language first when a run omits both language and code", () => {
		expect(parseError({ summary: "Listing available senpi tips for the tour", timeout: 60 }).message).toBe(
			LANGUAGE_TEACHING_ERROR,
		);
	});

	it("lists only the enabled languages when a run omits language", () => {
		expect(parseError({ code: "return 1", summary: "run without a language" }, ["js", "py"]).message).toBe(
			DEFAULT_ENABLED_LANGUAGE_TEACHING_ERROR,
		);
		expect(parseError({ code: "return 1", summary: "run without a language" }, ["js"]).message).toBe(
			JS_ONLY_LANGUAGE_TEACHING_ERROR,
		);
	});

	it("throws an actionable error when a run omits code", () => {
		expect(parseError({ language: "js", summary: "run without code" }).message).toBe(CODE_TEACHING_ERROR);
	});
});

describe("eval tool schema", () => {
	it("describes language as required for run with the kernel guide", () => {
		const tool = buildTool();
		const language = tool.parameters.properties.language as unknown as { readonly description?: string };
		expect(language.description).toContain(LANGUAGE_SCHEMA_DESCRIPTION);
	});

	it("describes code as required for run", () => {
		const tool = buildTool();
		const code = tool.parameters.properties.code as unknown as { readonly description?: string };
		expect(code.description).toContain(CODE_SCHEMA_DESCRIPTION);
	});
});

describe("eval tool execute error path", () => {
	it("surfaces the actionable language error as a tool error when language is missing", async () => {
		const tool = buildTool();
		const call = tool.execute(
			"cell-1",
			{ code: "return 42", summary: "run without a language" } as unknown as EvalToolRequest,
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		await expect(call).rejects.toThrow(TypeError);
		await expect(call).rejects.toThrow(JS_ONLY_LANGUAGE_TEACHING_ERROR);
	});
});
