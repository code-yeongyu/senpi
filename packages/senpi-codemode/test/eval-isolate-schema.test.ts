import { describe, expect, it } from "vitest";
import { EvalIsolateInvalidError, parseEvalRequest } from "../src/tool/eval-request.ts";
import { createEvalInputSchema } from "../src/tool/types.ts";

const allLanguages = { js: true, py: true, rb: true, jl: true };
const run = { language: "js", code: "1", summary: "s" };

type SchemaShape = {
	readonly properties: Record<string, unknown>;
	readonly anyOf?: readonly { readonly properties?: Record<string, unknown> }[];
};

function recordOf(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`expected ${what} to be an object, got ${JSON.stringify(value)}`);
	return Object.fromEntries(Object.entries(value));
}

function isSchemaShape(schema: unknown): schema is SchemaShape {
	if (typeof schema !== "object" || schema === null) return false;
	if (!("properties" in schema)) return false;
	try {
		recordOf(schema.properties, "schema.properties");
	} catch {
		return false;
	}
	if (!("anyOf" in schema) || schema.anyOf === undefined) return true;
	return Array.isArray(schema.anyOf);
}

function schemaShape(schema: unknown): SchemaShape {
	if (!isSchemaShape(schema))
		throw new Error(`expected a JSON schema object with properties, got ${JSON.stringify(schema)}`);
	return schema;
}

describe("Given sandbox cells are turned off", () => {
	it("When the eval schema is built, then it is byte-identical to the schema built with no sandbox option", () => {
		const withoutOption = JSON.stringify(createEvalInputSchema(allLanguages));
		const disabled = JSON.stringify(createEvalInputSchema(allLanguages, undefined, { sandbox: false }));

		expect(disabled).toBe(withoutOption);
		expect(disabled).not.toContain("isolate");
	});

	it("When a call passes isolate: true, then it is refused with eval_isolate_invalid instead of running as normal JavaScript", () => {
		expect(() => parseEvalRequest({ ...run, isolate: true })).toThrow(EvalIsolateInvalidError);
		expect(() => parseEvalRequest({ ...run, isolate: true })).toThrow("sandbox cells are turned off");
	});

	it("When a call passes isolate: false or omits it, then the request is the same as today", () => {
		expect(parseEvalRequest({ ...run, isolate: false })).toEqual(parseEvalRequest(run));
		expect(parseEvalRequest(run)).not.toHaveProperty("isolate");
	});
});

describe("Given sandbox cells are turned on", () => {
	it("When the eval schema is built, then it adds only the optional isolate boolean beside today's fields", () => {
		const base = schemaShape(createEvalInputSchema(allLanguages));
		const enabled = schemaShape(createEvalInputSchema(allLanguages, undefined, { sandbox: true }));

		expect(Object.keys(enabled.properties).filter((key) => !(key in base.properties))).toEqual(["isolate"]);
		expect(enabled.properties.isolate).toMatchObject({ type: "boolean" });
		expect(enabled.anyOf?.[0]?.properties).toHaveProperty("isolate");
		const { isolate: _isolate, ...rest } = enabled.properties;
		expect(JSON.stringify(rest)).toBe(JSON.stringify(base.properties));
	});

	it("When JavaScript is not an enabled language, then the schema has no isolate field", () => {
		const schema = JSON.stringify(
			createEvalInputSchema({ js: false, py: true, rb: false, jl: false }, undefined, { sandbox: true }),
		);

		expect(schema).not.toContain("isolate");
	});

	it("When a JavaScript call passes isolate: true, then the request carries it", () => {
		expect(parseEvalRequest({ ...run, isolate: true }, undefined, { sandbox: true })).toMatchObject({
			isolate: true,
		});
	});

	it.each([
		["another language", { ...run, language: "py", isolate: true }, "JavaScript only"],
		["reset", { ...run, isolate: true, reset: true }, "reset does not apply"],
		["a non-boolean value", { ...run, isolate: "yes" }, "true or false"],
	])("When the call has %s, then it is refused with eval_isolate_invalid", (_case, params, message) => {
		expect(() => parseEvalRequest(params, undefined, { sandbox: true })).toThrow(message);
		expect(() => parseEvalRequest(params, undefined, { sandbox: true })).toThrow(EvalIsolateInvalidError);
	});
});
