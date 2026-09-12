import { fromBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { buildMcpToolDefinitions } from "../src/api/cursor-agent.ts";

function decodeInputSchema(inputSchema: Uint8Array): unknown {
	return toJson(ValueSchema, fromBinary(ValueSchema, inputSchema));
}

describe("cursor MCP tool schema sanitization", () => {
	it("strips oneOf/anyOf/allOf from advertised tool schemas", () => {
		const tools = [
			{
				name: "scan",
				description: "scan things",
				parameters: {
					type: "object",
					properties: {
						ruleFile: { type: "string", minLength: 1 },
						inlineRules: { type: "string" },
					},
					required: ["ruleFile"],
					oneOf: [
						{ type: "object", required: ["ruleFile"], not: { required: ["inlineRules"] } },
						{ type: "object", required: ["inlineRules"], not: { required: ["ruleFile"] } },
					],
				},
			},
		];
		const definitions = buildMcpToolDefinitions(tools);
		expect(definitions).toHaveLength(1);
		const decoded = decodeInputSchema(definitions[0].inputSchema) as Record<string, unknown>;
		expect(decoded.oneOf).toBeUndefined();
		expect(decoded.type).toBe("object");
		expect((decoded.properties as Record<string, unknown>).ruleFile).toEqual({
			type: "string",
			minLength: 1,
		});
		expect(decoded.required).toEqual(["ruleFile"]);
	});

	it("strips nested composition keywords inside property schemas", () => {
		const tools = [
			{
				name: "nested",
				description: "nested",
				parameters: {
					type: "object",
					properties: {
						filter: {
							type: "object",
							properties: { kind: { type: "string" } },
							anyOf: [{ required: ["kind"] }],
						},
						list: {
							type: "array",
							items: { type: "object", allOf: [{ required: ["x"] }] },
						},
					},
				},
			},
		];
		const definitions = buildMcpToolDefinitions(tools);
		const decoded = decodeInputSchema(definitions[0].inputSchema) as {
			properties: Record<string, Record<string, unknown> & { items?: Record<string, unknown> }>;
		};
		const filter = decoded.properties.filter as Record<string, unknown>;
		expect(filter.anyOf).toBeUndefined();
		expect((filter.properties as Record<string, unknown>).kind).toEqual({ type: "string" });
		const items = decoded.properties.list.items as Record<string, unknown>;
		expect(items.allOf).toBeUndefined();
	});

	it("passes clean schemas through unchanged", () => {
		const parameters = {
			type: "object",
			properties: {
				pattern: { type: "string", maxLength: 16384 },
				lang: { enum: ["ts", "py"] },
				not: { required: ["other"] },
			},
			required: ["pattern"],
			additionalProperties: false,
		};
		const definitions = buildMcpToolDefinitions([{ name: "clean", description: "clean tool", parameters }]);
		const decoded = decodeInputSchema(definitions[0].inputSchema);
		expect(decoded).toEqual(parameters);
	});
});
