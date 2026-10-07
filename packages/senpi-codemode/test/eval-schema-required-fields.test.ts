import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { buildAnthropicWarmPromptCacheParams } from "../../ai/src/api/anthropic-messages.ts";
import { convertTools as convertGoogleTools } from "../../ai/src/api/google-shared.ts";
import { convertResponsesTools } from "../../ai/src/api/openai-responses-shared.ts";
import { getModel } from "../../ai/src/compat.ts";
import type { Tool } from "../../ai/src/types.ts";
import {
	normalizeToolParametersForBedrock,
	normalizeToolParametersForMoonshot,
	normalizeToolParametersForOpenAICompat,
} from "../../ai/src/utils/tool-schema-compat.ts";
import { createEvalInputSchema } from "../src/tool/types.ts";

// senpi#2240: Mistral-hosted GLM needs branch-local field definitions for complete calls.
describe("eval action schemas", () => {
	const schema = createEvalInputSchema({ js: true, py: true, rb: false, jl: false });
	const run = { language: "py", code: "print(2 + 2)", summary: "Calculate four." };
	const tool: Tool = { name: "eval", description: "Run code or control eval cells.", parameters: schema };

	it("preserves valid runs and controls through provider schema conversions", () => {
		const anthropic = buildAnthropicWarmPromptCacheParams(getModel("anthropic", "claude-haiku-4-5"), {
			messages: [],
			tools: [tool],
		}).tools?.[0];
		const responses = convertResponsesTools([tool])[0];
		expect(anthropic && "input_schema" in anthropic).toBe(true);
		expect(responses.type).toBe("function");
		if (!anthropic || !("input_schema" in anthropic) || responses.type !== "function") return;
		for (const wire of [
			anthropic.input_schema,
			responses.parameters,
			convertGoogleTools([tool])?.[0].functionDeclarations[0].parametersJsonSchema,
			convertGoogleTools([tool], true)?.[0].functionDeclarations[0].parameters,
			normalizeToolParametersForOpenAICompat({ ...schema }),
			normalizeToolParametersForMoonshot({ ...schema }),
			normalizeToolParametersForBedrock({ ...schema }),
		]) {
			expect(wire).toBeDefined();
			const converted: TSchema = JSON.parse(JSON.stringify(wire));
			for (const field of Object.keys(schema.properties)) expect(converted).toHaveProperty(`properties.${field}`);
			for (const input of [
				run,
				{ ...run, action: "run" },
				{ action: "list" },
				...["peek", "stop"].map((action) => ({ action, cell_id: "cell-1" })),
			]) {
				expect(Check(converted, input)).toBe(true);
			}
		}
	});

	// senpi#2569: Anthropic-compatible gateways (CodeBuddy-backed routes) reject the whole
	// request, HTTP 400 code 11133, when a root anyOf branch carries an enum. Every wire form
	// the providers send must keep the branches enum-free (const-typed literals instead).
	it("keeps every root anyOf branch free of enum in each provider's wire schema", () => {
		const enumPaths = (node: unknown, path: string): string[] => {
			if (node === null || typeof node !== "object") return [];
			const own = "enum" in node ? [path] : [];
			return [...own, ...Object.entries(node).flatMap(([key, value]) => enumPaths(value, `${path}.${key}`))];
		};
		const anthropic = buildAnthropicWarmPromptCacheParams(getModel("anthropic", "claude-haiku-4-5"), {
			messages: [],
			tools: [tool],
		}).tools?.[0];
		const wires: Array<[string, unknown]> = [
			["raw", schema],
			["anthropic", anthropic && "input_schema" in anthropic ? anthropic.input_schema : undefined],
			["openai-compat", normalizeToolParametersForOpenAICompat({ ...schema })],
			["moonshot", normalizeToolParametersForMoonshot({ ...schema })],
		];
		for (const [label, wire] of wires) {
			expect(wire, label).toBeDefined();
			const branches = (JSON.parse(JSON.stringify(wire)) as { anyOf?: unknown[] }).anyOf ?? [];
			// The raw schema keeps the run/control union; a converter may flatten it away entirely.
			if (label === "raw") expect(branches.length).toBeGreaterThan(0);
			expect(branches.flatMap((branch, i) => enumPaths(branch, `${label}.anyOf[${i}]`))).toEqual([]);
		}
	});

	it("falls back from preferred OpenAI strict sampling without requiring run fields on controls", () => {
		expect(
			convertResponsesTools([{ ...tool, constrainedSampling: { type: "json_schema", strict: "prefer" } }])[0],
		).toMatchObject({
			strict: false,
			parameters: schema,
		});
		expect(() =>
			convertResponsesTools([{ ...tool, constrainedSampling: { type: "json_schema", strict: "require" } }]),
		).toThrow("object and array unions are unsupported");
	});

	it("requires every run field with an explicit or omitted action", () => {
		for (const action of [{ action: "run" }, {}]) {
			expect(Check(schema, { ...run, ...action })).toBe(true);
			expect(Check(schema, action)).toBe(false);
			for (const field of Object.keys(run)) {
				const incomplete = Object.fromEntries(Object.entries(run).filter(([name]) => name !== field));
				expect(Check(schema, { ...incomplete, ...action })).toBe(false);
			}
		}
	});

	it("keeps list, peek and stop usable without run fields", () => {
		expect(Check(schema, { action: "list" })).toBe(true);
		for (const action of ["peek", "stop"]) {
			expect(Check(schema, { action, cell_id: "cell-1" })).toBe(true);
			expect(Check(schema, { action })).toBe(false);
			expect(Check(schema, { action, cell_id: "" })).toBe(false);
		}
		expect(Check(schema, { ...run, action: "unknown" })).toBe(false);
		expect(Check(schema, { ...run, language: "rb" })).toBe(false);
	});

	it("declares every required field inside the branch that requires it", () => {
		const wire: { anyOf?: { properties?: Record<string, unknown>; required?: string[] }[] } = JSON.parse(
			JSON.stringify(schema),
		);
		expect(wire.anyOf).toBeDefined();
		for (const branch of wire.anyOf ?? []) {
			for (const field of branch.required ?? []) {
				expect(branch.properties).toHaveProperty(field);
			}
		}
	});
});
