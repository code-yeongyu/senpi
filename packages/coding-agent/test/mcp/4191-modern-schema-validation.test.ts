import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedToolsToCatalogEntries, collectToolCatalog } from "../../src/core/extensions/builtin/mcp/catalog.ts";
import {
	collectServerCatalogForCache,
	readMcpCatalogCache,
	writeMcpCachedServer,
} from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { normalizeServer } from "../../src/core/extensions/builtin/mcp/config.ts";
import {
	buildMcpToolDefinitions,
	executeMcpCatalogEntry,
} from "../../src/core/extensions/builtin/mcp/expose/register.ts";
import { compileModernSchema } from "../../src/core/extensions/builtin/mcp/modern/tool-schema.ts";
import { createMcpInvocationResolver } from "../../src/core/extensions/builtin/mcp/invocation.ts";
import { callMcpToolRequest, listMcpTools } from "../../src/core/extensions/builtin/mcp/tool-client.ts";
import { cleanupMrtrConnections, connect } from "./fixtures/mrtr-connection.ts";
import { cleanupRoots, makeRoot } from "./fixtures/service-lifecycle.ts";

const roots: Array<() => Promise<void>> = [];
afterEach(async () => {
	await cleanupMrtrConnections();
	await cleanupRoots(roots);
});

// senpi#4191: validate the real modern wire data, not an object-shaped substitute.
describe("modern schema validation", () => {
	it.each([
		{ schema: { type: "null" }, value: null },
		{ schema: { type: "boolean" }, value: false },
		{ schema: { type: "number" }, value: 0 },
		{ schema: { type: "string" }, value: "" },
		{ schema: { type: "array", prefixItems: [{ type: "integer" }], items: false }, value: [1] },
		{ schema: true, value: { any: [false, null] } },
	])("accepts structuredContent $value against $schema", async ({ schema, value }) => {
		const { connection } = await connect([{ content: [], structuredContent: value }], false, false);
		const result = await callMcpToolRequest(connection.client, { name: "fixture" }, schema);
		expect(result.structuredContent).toEqual(value);
	});

	it.each([
		{ schema: { type: "number" }, result: { structuredContent: "0" } },
		{ schema: { type: "null" }, result: {} },
		{ schema: false, result: { structuredContent: null } },
		{
			schema: { type: "array", prefixItems: [{ type: "integer" }], items: false },
			result: { structuredContent: [1, 2] },
		},
	])("rejects missing or invalid structured output without coercion", async ({ schema, result }) => {
		const { connection } = await connect([{ content: [], ...result }], false, false);
		await expect(callMcpToolRequest(connection.client, { name: "fixture" }, schema)).rejects.toMatchObject({
			code: "MCP_OUTPUT_SCHEMA_MISMATCH",
		});
	});

	it("does not require structured output on an execution error", async () => {
		const { connection } = await connect([{ content: [], isError: true }], false, false);
		await expect(callMcpToolRequest(connection.client, { name: "fixture" }, false)).resolves.toMatchObject({
			isError: true,
		});
	});

	it.each([
		{ schema: { $schema: "http://json-schema.org/draft-07/schema#" }, code: "MCP_SCHEMA_UNSUPPORTED_DIALECT" },
		{ schema: { $schema: "https://example.invalid/dialect" }, code: "MCP_SCHEMA_UNSUPPORTED_DIALECT" },
		{ schema: { $ref: "https://example.invalid/schema" }, code: "MCP_SCHEMA_INVALID" },
		{ schema: { type: "bogus" }, code: "MCP_SCHEMA_INVALID" },
	])("drops only the unsupported definition at discovery: $code", async ({ schema, code }) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { connection, script } = await connect([], false, false);
		script.tools = [
			{ name: "before", inputSchema: true },
			{ name: "unsupported", inputSchema: schema },
			{ name: "after", inputSchema: { type: "object" } },
		];
		const result = await listMcpTools(connection.client);
		expect(result.tools.map((tool) => tool.name)).toEqual(["before", "after"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsupported"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(code));
	});

	it("reports the argument path and keyword so the model can correct a modern call", async () => {
		const { connection, script } = await connect([], false, false);
		script.tools = [
			{
				name: "fixture",
				inputSchema: {
					type: "object",
					properties: { count: { type: "integer" } },
					required: ["count"],
				},
			},
		];
		const entries = await collectToolCatalog("fixture", connection, normalizeServer({ command: "unused" }));
		const tool = buildMcpToolDefinitions(entries)[0];
		if (!tool) throw new Error("Expected fixture");
		for (const [args, keyword] of [
			[{ count: "private-value" }, "type"],
			[{}, "required"],
		] as const) {
			let message = "";
			try {
				validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: args });
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain("count:");
			expect(message).toContain(keyword);
			expect(message).not.toContain("private-value");
		}
		expect(script.requests).toEqual([]);
	});

	it("uses the live modern era for a pre-upgrade cache without the modern flag", async () => {
		const { connection, script } = await connect([], false, false);
		script.tools = [
			{
				name: "fixture",
				inputSchema: { type: "object", properties: { count: { type: "integer" } }, additionalProperties: false },
			},
		];
		const { modern: _modern, ...oldCache } = await collectServerCatalogForCache(
			connection,
			{ requestTimeoutMs: 10_000 },
			"schema-config",
		);
		const entries = cachedToolsToCatalogEntries("fixture", oldCache, connection, 10_000, async () => {});
		const tool = buildMcpToolDefinitions(entries)[0];
		if (!tool) throw new Error("Expected fixture");
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call",
				name: tool.name,
				arguments: { count: "3" },
			}),
		).toThrow();
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call",
				name: tool.name,
				arguments: { count: 3, extra: true },
			}),
		).toThrow();
	});

	it("drops invalid cached input and output schemas before tool registration", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const root = makeRoot("invalid-schema-cache", roots);
		const { connection, script } = await connect([], false, false);
		script.tools = [{ name: "valid", inputSchema: true }];
		const catalog = await collectServerCatalogForCache(connection, { requestTimeoutMs: 10_000 }, "schema-config");
		await writeMcpCachedServer(root.agentDir, "fixture", {
			...catalog,
			tools: [
				...catalog.tools,
				{ name: "invalid-input", inputSchema: { type: "bogus" } },
				{ name: "invalid-output", inputSchema: true, outputSchema: { $ref: "https://example.invalid/schema" } },
			],
		});
		const cached = (await readMcpCatalogCache(root.agentDir)).servers.fixture;
		if (!cached) throw new Error("Missing cached catalog");
		const entries = cachedToolsToCatalogEntries("fixture", cached, connection, 10_000, async () => {});
		expect(buildMcpToolDefinitions(entries).map((tool) => tool.name)).toEqual(["mcp_fixture_valid"]);
		for (const name of ["invalid-input", "invalid-output"]) {
			expect(warn).toHaveBeenCalledWith(expect.stringContaining(name));
		}
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("MCP_SCHEMA_INVALID"));
	});

	it("refuses a newly invalid current schema without dispatching or throwing", async () => {
		const { connection, script, logger } = await connect([], false, false);
		script.tools = [{ name: "fixture", inputSchema: true }];
		const [offered] = await collectToolCatalog("fixture", connection, normalizeServer({ command: "unused" }));
		if (!offered) throw new Error("Expected fixture");
		const resolver = createMcpInvocationResolver({
			owner: {},
			sink: { logger },
			configuration: "fixture",
			contextRequired: false,
			isCurrent: () => true,
			ready: async () => {},
			current: () => ({ ...offered, schema: { type: "bogus" } }),
		});
		const result = await executeMcpCatalogEntry({ ...offered, invocation: resolver }, {}, undefined, undefined);
		expect(result).toMatchObject({ details: { error: { kind: "schema_changed", tool: "fixture" } } });
		expect(script.requests).toEqual([]);
	});

	it("enforces ref siblings and unevaluatedProperties without rewriting arguments", async () => {
		const { connection, script } = await connect([], false, false);
		script.tools = [
			{
				name: "fixture",
				inputSchema: {
					$defs: { count: { type: "integer", minimum: 0 } },
					type: "object",
					properties: { count: { $ref: "#/$defs/count", maximum: 5 } },
					unevaluatedProperties: false,
				},
			},
		];
		const entries = await collectToolCatalog("fixture", connection, normalizeServer({ command: "unused" }));
		const tool = buildMcpToolDefinitions(entries)[0];
		if (!tool) throw new Error("Expected fixture");
		const invalid: ToolCall["arguments"][] = [{ count: 6 }, { count: "3" }, { count: 3, extra: 1 }];
		for (const args of invalid) {
			expect(() =>
				validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: args }),
			).toThrow();
		}
		expect(script.requests).toEqual([]);
	});

	it("round trips raw schemas and protocol era through the persistent cache", async () => {
		const root = makeRoot("schema-cache", roots);
		const { connection, script } = await connect([{ content: [], structuredContent: false }], false, false);
		script.tools = [{ name: "fixture", inputSchema: true, outputSchema: { type: "boolean" } }];
		const catalog = await collectServerCatalogForCache(connection, { requestTimeoutMs: 10_000 }, "schema-config");
		await writeMcpCachedServer(root.agentDir, "fixture", catalog);
		const cached = (await readMcpCatalogCache(root.agentDir)).servers.fixture;
		expect(cached?.tools).toEqual(catalog.tools);
		if (!cached) throw new Error("Missing cached catalog");
		const entries = cachedToolsToCatalogEntries("fixture", cached, connection, 10_000, async () => {});
		const entry = entries[0];
		if (!entry) throw new Error("Expected cached fixture");
		const result = await executeMcpCatalogEntry(entry, {}, undefined, undefined);
		expect(result.content).toEqual([{ type: "text", text: "false" }]);
	});

	it("bounds schema depth and isolates identical schema identifiers", () => {
		let deep: Record<string, unknown> = { type: "object" };
		for (let index = 0; index < 70; index++) deep = { allOf: [deep] };
		expect(() => compileModernSchema(deep)).toThrow(expect.objectContaining({ code: "MCP_SCHEMA_LIMIT" }));
		const first = compileModernSchema({ $id: "urn:test:schema", const: 1 });
		const second = compileModernSchema({ $id: "urn:test:schema", const: 2 });
		expect([first(1), first(2), second(1), second(2)]).toEqual([true, false, false, true]);
	});
});
