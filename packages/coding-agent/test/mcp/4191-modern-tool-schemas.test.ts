import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { collectToolCatalog } from "../../src/core/extensions/builtin/mcp/catalog.ts";
import { normalizeServer } from "../../src/core/extensions/builtin/mcp/config.ts";
import {
	buildMcpToolDefinitions,
	executeMcpCatalogEntry,
} from "../../src/core/extensions/builtin/mcp/expose/register.ts";
import { cleanupMrtrConnections, connect } from "./fixtures/mrtr-connection.ts";

afterEach(cleanupMrtrConnections);

async function fixture(inputSchema: unknown, outputSchema?: unknown, structuredContent?: unknown) {
	const peer = await connect([{ resultType: "complete", content: [], structuredContent }], false, false);
	peer.script.tools = [{ name: "echo", inputSchema, ...(outputSchema === undefined ? {} : { outputSchema }) }];
	const entries = await collectToolCatalog("fixture", peer.connection, normalizeServer({ command: "unused" }));
	const tool = buildMcpToolDefinitions(entries)[0];
	const entry = entries[0];
	if (!tool || !entry) throw new Error("Expected echo tool");
	return {
		...peer,
		entries,
		tool,
		execute: (args: Record<string, unknown>) => executeMcpCatalogEntry(entry, args, undefined, undefined),
	};
}

// senpi#4191: port the eight HTTP/conversion failures from the spec audit.
describe("modern MCP tool schemas", () => {
	it.each([
		{ label: "boolean inputSchema", inputSchema: true },
		{
			label: "array outputSchema",
			inputSchema: { type: "object" },
			outputSchema: { type: "array", items: { type: "string" } },
		},
	])("accepts $label through discovery and exposure", async ({ inputSchema, ...rest }) => {
		const outputSchema = "outputSchema" in rest ? rest.outputSchema : undefined;
		const { entries } = await fixture(inputSchema, outputSchema);
		expect(entries[0]?.schema).toEqual(inputSchema);
	});

	it.each([null, false, 0, "text", [1, 2]].map((value) => ({ value })))(
		"delivers non-object structuredContent $value to the model",
		async ({ value }) => {
			const { execute } = await fixture({ type: "object" }, undefined, value);
			const result = await execute({});
			expect(result.content).toEqual([{ type: "text", text: JSON.stringify(value) }]);
		},
	);

	it("retains additionalProperties and ref sibling constraints in the exposed schema", async () => {
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			$defs: { count: { type: "integer", minimum: 0 } },
			properties: { count: { $ref: "#/$defs/count", maximum: 5 } },
		};
		const { tool } = await fixture(schema);
		expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(schema);
	});

	it("sends exactly the model arguments after validation and exposure", async () => {
		const { tool, script, execute } = await fixture({
			type: "object",
			properties: {
				value: { anyOf: [{ type: "integer" }, { type: "string" }] },
				optionalCount: { type: "integer" },
			},
			required: ["value"],
		});
		const argumentsFromModel = { value: "007", extra: { nested: [false, null, 0] } };
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "call",
			name: tool.name,
			arguments: argumentsFromModel,
		});
		await execute(args);
		expect(script.requests[0]?.params?.arguments).toEqual(argumentsFromModel);
		expect(argumentsFromModel.value).toBe("007");
		// The legacy path silently removes optional nulls and dispatches the repaired call.
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "invalid",
				name: tool.name,
				arguments: { ...argumentsFromModel, optionalCount: null },
			}),
		).toThrow();
		expect(script.requests).toHaveLength(1);
	});
});
