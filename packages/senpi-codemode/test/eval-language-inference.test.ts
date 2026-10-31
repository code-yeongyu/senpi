import { type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { classifyEvalCode, inferEvalLanguage } from "../src/tool/eval-language-inference.ts";
import { parseEvalRequest } from "../src/tool/eval-request.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EnabledEvalLanguages } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

const TWO_LANGUAGE_TEACHING_ERROR = 'eval run requires language: one of "js", "py"';

function buildTool(enabledLanguages: EnabledEvalLanguages) {
	return createEvalTool({
		enabledLanguages,
		kernelManager: new FakeManager([
			["js", new FakeKernel([result("cell-1", "1", 1)])],
			["py", new FakeKernel([result("cell-1", "1", 1)])],
		]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
	});
}

function validate(enabledLanguages: EnabledEvalLanguages, args: JsonObject): unknown {
	const tool = buildTool(enabledLanguages);
	return validateToolArguments(
		{ name: "eval", description: "eval", parameters: tool.parameters },
		{ type: "toolCall", id: "call-1", name: "eval", arguments: args },
	);
}

const JS_AND_PY: EnabledEvalLanguages = { js: true, py: true, rb: false, jl: false };
const JS_ONLY: EnabledEvalLanguages = { js: true, py: false, rb: false, jl: false };
const PY_ONLY: EnabledEvalLanguages = { js: false, py: true, rb: false, jl: false };

// A cell that omits language is filled only when the kernel is unambiguous; any conflicting signal fills nothing.
describe("classifyEvalCode", () => {
	it.each([
		["def main():\n    return 1", "py"],
		["    def helper(x):\n        return x", "py"],
		["import os\nos.getcwd()", "py"],
		["import os.path as osp, sys", "py"],
		["from pathlib import Path\nPath('.').resolve()", "py"],
		["const r = await read('a.txt')\nr", "js"],
		["let total = 0\ntotal", "js"],
		["[1, 2].map((x) => x * 2)", "js"],
		["console.log(1)", "js"],
		["return await tool.grep({ pattern: 'x' })", "js"],
		['import { join } from "node:path"\njoin("a", "b")', "js"],
		// `print(` is a prelude helper in both runtimes, so only the JS-only forms around it decide.
		["print(await read('a.txt'))", "js"],
		["print(JSON.stringify(data))", "js"],
		["print(Object.keys(x))", "js"],
		[`print(\`a \${b}\`)`, "js"],
		["print(await tool.grep({ pattern: 'x' }))", "js"],
		["const x = 1\nprint(x)", "js"],
		["import fs from 'node:fs'\nprint(fs)", "js"],
	] as const)("classifies %j as %s", (code, language) => {
		expect(classifyEvalCode(code)).toBe(language);
	});

	it.each([
		["no markers at all", "1 + 1"],
		["no markers at all", "return 1"],
		["print alone, shared by both runtimes", "print(result)"],
		["print of a call, shared by both runtimes", "print(len('abc'))"],
		["JS const beside a Python True", "const s = 'True'"],
		["python def beside a trailing brace", "def f():\n    return {\n    }"],
		["python import beside an arrow", "import os\nf = lambda: 1  # => one"],
		["python def beside console.log", "def f():\n    console.log(1)"],
		["print with a JS statement terminator", "print(1);"],
		["print beside a JS null", "print(null)"],
		["JS const beside a Python None", "const x = None"],
		["arrow beside a Python block header", "if ok:\n    xs.map((x) => x)"],
	] as const)("refuses to classify %s", (_label, code) => {
		expect(classifyEvalCode(code)).toBeUndefined();
	});
});

describe("inferEvalLanguage", () => {
	it("fills the only enabled language whatever the code says", () => {
		expect(inferEvalLanguage("def f():\n    pass", ["js"])).toEqual({
			language: "js",
			basis: "only-enabled-language",
		});
		expect(inferEvalLanguage("1 + 1", ["py"])).toEqual({ language: "py", basis: "only-enabled-language" });
	});

	it("fills from code markers only when exactly js and py are enabled", () => {
		expect(inferEvalLanguage("import os", ["js", "py"])).toEqual({ language: "py", basis: "code-markers" });
		expect(inferEvalLanguage("console.log(1)", ["js", "py"])).toEqual({ language: "js", basis: "code-markers" });
		expect(inferEvalLanguage("1 + 1", ["js", "py"])).toBeUndefined();
		expect(inferEvalLanguage("import os", ["js", "py", "rb"])).toBeUndefined();
		expect(inferEvalLanguage(undefined, ["js", "py"])).toBeUndefined();
	});
});

describe("parseEvalRequest language inference", () => {
	it("fills the only enabled language and says it was inferred", () => {
		expect(parseEvalRequest({ code: "1 + 1", summary: "Add" }, ["js"])).toEqual({
			language: "js",
			code: "1 + 1",
			summary: "Add",
			language_inferred: "only-enabled-language",
		});
	});

	it.each([
		["import json\nprint(json.dumps({}))", "py"],
		["const xs = await tool.read({ path: 'a' })", "js"],
	] as const)("fills %j as %s when js and py are enabled", (code, language) => {
		expect(parseEvalRequest({ code, summary: "Run" }, ["js", "py"])).toMatchObject({
			language,
			language_inferred: "code-markers",
		});
	});

	it("keeps the teaching error when js and py are enabled and the markers conflict", () => {
		expect(() => parseEvalRequest({ code: "const s = 'True'", summary: "Run" }, ["js", "py"])).toThrow(
			TWO_LANGUAGE_TEACHING_ERROR,
		);
	});

	it("never changes an explicit language", () => {
		const request = parseEvalRequest({ language: "js", code: "def f():\n    pass", summary: "Run" }, ["js", "py"]);
		expect(request).toEqual({ language: "js", code: "def f():\n    pass", summary: "Run" });
	});
});

describe("eval argument validation language inference", () => {
	it("fills the only enabled language before the missing-language check", () => {
		expect(validate(PY_ONLY, { code: "1 + 1", summary: "Add" })).toMatchObject({
			language: "py",
			language_inferred: "only-enabled-language",
		});
	});

	it.each([
		["from os import path\npath.sep", "py"],
		["const sep = '/'\nsep", "js"],
	] as const)("fills %j as %s when js and py are enabled", (code, language) => {
		expect(validate(JS_AND_PY, { action: "run", code, summary: "Run" })).toMatchObject({
			language,
			language_inferred: "code-markers",
		});
	});

	it("reports the missing language when the markers conflict", () => {
		expect(() => validate(JS_AND_PY, { code: "let s = None", summary: "Run" })).toThrow(
			TWO_LANGUAGE_TEACHING_ERROR,
		);
	});

	it("never changes an explicit language and drops a caller-sent inference marker", () => {
		const validated = validate(JS_AND_PY, {
			language: "js",
			code: "import os",
			summary: "Run",
			language_inferred: "code-markers",
		});
		expect(validated).toEqual({ language: "js", code: "import os", summary: "Run" });
	});

	it("reports the caller's own arguments when a filled call still fails validation", () => {
		const args = { code: "1 + 1", summary: "Add", timeout: "abc" };
		const message = (() => {
			try {
				validate(PY_ONLY, args);
			} catch (error) {
				if (error instanceof Error) return error.message;
				throw error;
			}
			throw new Error("expected eval validation to fail");
		})();
		expect(message).toContain(`\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`);
		expect(message).not.toContain('"language"');
	});
});

describe("eval tool reports an inferred language", () => {
	it("leads the result with a machine-readable inference line", async () => {
		const tool = buildTool(JS_ONLY);
		const output = await tool.execute(
			"cell-1",
			{ code: "1", summary: "One" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		expect(output.content[0]).toEqual({
			type: "text",
			text: "language_inferred: js (only-enabled-language). This eval run omitted language; pass language explicitly.",
		});
	});

	it("ignores an inference marker that argument validation did not set", async () => {
		const tool = buildTool(JS_ONLY);
		const output = await tool.execute(
			"cell-1",
			{ language: "js", code: "1", summary: "One", language_inferred: "code-markers" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		expect(JSON.stringify(output.content)).not.toContain("language_inferred");
	});

	it("keeps the inference line for arguments the validator filled", async () => {
		const tool = buildTool(JS_ONLY);
		const validated = validateToolArguments(
			{ name: "eval", description: "eval", parameters: tool.parameters },
			{ type: "toolCall", id: "call-1", name: "eval", arguments: { code: "1", summary: "One" } },
		);
		const output = await tool.execute("cell-1", validated, undefined, undefined, fakeExtensionContext());
		expect(output.content[0]).toEqual({
			type: "text",
			text: "language_inferred: js (only-enabled-language). This eval run omitted language; pass language explicitly.",
		});
	});

	it("adds no inference line when the language was given", async () => {
		const tool = buildTool(JS_ONLY);
		const output = await tool.execute(
			"cell-1",
			{ language: "js", code: "1", summary: "One" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		expect(JSON.stringify(output.content)).not.toContain("language_inferred");
	});
});
