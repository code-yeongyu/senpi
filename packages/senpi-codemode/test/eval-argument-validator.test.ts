import { type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, FakeManager, result } from "./eval/fakes.ts";

type EvalTool = ReturnType<typeof createEvalTool>;

interface ValidationLine {
	readonly field: string;
	readonly message: string;
	readonly keyword: string;
}

function buildTool(): EvalTool {
	return createEvalTool({
		enabledLanguages: { js: true, py: true, rb: false, jl: false },
		kernelManager: new FakeManager([["js", new FakeKernel([result("cell-1", "1", 1)])]]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
	});
}

function validate(tool: EvalTool, args: JsonObject): unknown {
	return validateToolArguments(
		{ name: "eval", description: "eval", parameters: tool.parameters },
		{ type: "toolCall", id: "call-1", name: "eval", arguments: args },
	);
}

// The protocol-validator formatter emits one "  - <field>: <message> (<keyword>)" line per error.
function validationLines(tool: EvalTool, args: JsonObject): ValidationLine[] {
	try {
		validate(tool, args);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return error.message
			.split("\n")
			.slice(1)
			.map((line) => {
				const match = /^ {2}- ([^:]+): (.*) \(([a-z]+)\)$/u.exec(line);
				if (!match) throw new Error(`unstructured validation line: ${line}`);
				return { field: match[1], message: match[2], keyword: match[3] };
			});
	}
	throw new Error("expected eval validation to fail");
}

// senpi#5138: a run call missing a run field must get the eval-specific error, not the anyOf branch dump.
describe("eval argument validator", () => {
	const tool = buildTool();
	const run = { language: "py", code: "print(1)", summary: "Print one." };

	it("reports a missing language first, naming the enabled languages", () => {
		const actions: JsonObject[] = [{}, { action: "run" }];
		for (const action of actions) {
			const lines = validationLines(tool, { code: run.code, summary: run.summary, ...action });
			expect(lines.map(({ field, keyword }) => ({ field, keyword }))).toEqual([
				{ field: "language", keyword: "required" },
			]);
			expect(lines[0]?.message).toContain('"js", "py"');
		}
	});

	it("reports every missing run field, in language, code, summary order, and nothing else", () => {
		expect(validationLines(tool, { action: "run" }).map(({ field }) => field)).toEqual([
			"language",
			"code",
			"summary",
		]);
		expect(validationLines(tool, { language: "py" }).map(({ field }) => field)).toEqual(["code", "summary"]);
		expect(validationLines(tool, { ...run, language: null }).map(({ field }) => field)).toEqual(["language"]);
	});

	it("accepts complete runs with the same argument coercion as before", () => {
		expect(validate(tool, run)).toEqual(run);
		expect(validate(tool, { ...run, action: "run", timeout: "30", reset: null })).toEqual({
			...run,
			action: "run",
			timeout: 30,
		});
	});

	it("keeps list, peek and stop validating without run fields", () => {
		expect(validate(tool, { action: "list" })).toEqual({ action: "list" });
		for (const action of ["peek", "stop"]) {
			expect(validate(tool, { action, cell_id: "cell-1" })).toEqual({ action, cell_id: "cell-1" });
			expect(() => validate(tool, { action })).toThrow(/Validation failed for tool "eval"/u);
		}
		expect(() => validate(tool, { ...run, language: "rb" })).toThrow(/Validation failed for tool "eval"/u);
	});
});
