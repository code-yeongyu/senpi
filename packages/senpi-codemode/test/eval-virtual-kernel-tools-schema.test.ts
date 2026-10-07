import { describe, expect, it } from "vitest";
import { virtualEvalSchema } from "../src/bridges/eval-virtual-schemas.ts";

describe("tool_schema('eval:kernel-tools')", () => {
	it("documents @tool, tool.defined()/undefine(), the inference rules and grant staleness", () => {
		const found = virtualEvalSchema("eval:kernel-tools");
		if (found === undefined || !("name" in found)) throw new Error("eval:kernel-tools is not a named schema entry");
		const entry = found;

		expect(entry.name).toBe("eval:kernel-tools");
		expect(entry.description).toContain("@tool");
		expect(entry.description).toContain("tool.defined()");
		expect(entry.description).toContain("kernel_tool_stale");
		expect(entry.description).toContain("invalid_tool_definition");
		expect(Object.keys((entry.parameters as { properties: object }).properties)).toEqual([
			"tool",
			"tool.defined",
			"tool.undefine",
		]);
	});

	it("is not listed under an unrelated name", () => {
		expect(virtualEvalSchema("eval:kernel-tool")).toBeUndefined();
	});
});
