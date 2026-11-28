import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedToolsToCatalogEntries } from "../../../src/core/extensions/builtin/mcp/catalog.ts";
import {
	collectServerCatalogForCache,
	getMcpCatalogCachePath,
	readMcpCatalogCache,
	writeMcpCachedServer,
} from "../../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { loadMcpConfig } from "../../../src/core/extensions/builtin/mcp/config.ts";
import {
	buildMcpToolDefinitions,
	executeMcpCatalogEntry,
} from "../../../src/core/extensions/builtin/mcp/expose/register.ts";
import { compileModernSchema } from "../../../src/core/extensions/builtin/mcp/modern/tool-schema.ts";
import { getMcpService, resetMcpServiceForTests } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { callMcpToolRequest } from "../../../src/core/extensions/builtin/mcp/tool-client.ts";
import { cleanupMrtrConnections, connect } from "../../mcp/fixtures/mrtr-connection.ts";
import { attach, capturingPi, registeredTool } from "../../mcp/fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer } from "../../mcp/fixtures/service-lifecycle.ts";

const roots: Array<() => Promise<void>> = [];
afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupMrtrConnections();
	await cleanupRoots(roots);
	vi.restoreAllMocks();
});

// senpi#5402: loading and registering a fresh disk catalog must not compile validators.
describe("lazy modern MCP schema compilation", () => {
	it("loads 170 cached tools without compiling, then compiles only the schemas used", async () => {
		const root = makeRoot("lazy-schema-compilation", roots);
		setConfig(root, { fx: { ...stdioServer([]), exposure: "direct" } });
		const config = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });
		const server = config.servers.fx;
		if (!server) throw new Error("Missing fixture config");
		const tools = Array.from({ length: 170 }, (_, index) => ({
			name: `tool_${index}`,
			inputSchema: {
				type: "object",
				description: `input ${index} ${"schema description ".repeat(320)}`,
				properties: { value: { type: "integer", minimum: index } },
				required: ["value"],
			},
			outputSchema: {
				type: "integer",
				description: `output ${index} ${"schema description ".repeat(320)}`,
				minimum: index,
			},
		}));
		const path = getMcpCatalogCachePath(root.agentDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				servers: {
					fx: {
						modern: true,
						configHash: server.configHash,
						fetchedAt: Date.now(),
						tools,
						resources: [],
						prompts: [],
					},
				},
			}),
		);
		const compile = vi.spyOn(Ajv2020.prototype, "compile");
		const validateSchema = vi.spyOn(Ajv2020.prototype, "validateSchema");
		const pi = capturingPi();

		await attach(root, pi);

		expect([...pi.toolDefinitions.keys()].filter((name) => name.startsWith("mcp_fx_"))).toHaveLength(170);
		expect(compile.mock.calls.length).toBe(0);
		expect(validateSchema.mock.calls.length).toBe(0);
		const tool = registeredTool(pi, "mcp_fx_tool_0");
		const call = { type: "toolCall", id: "first", name: tool.name, arguments: { value: 1 } } as const;
		expect(validateToolArguments(tool, call)).toEqual({ value: 1 });
		expect(compile).toHaveBeenCalledTimes(1);
		expect(() => validateToolArguments(tool, { ...call, arguments: { value: "private-value" } })).toThrow(
			"value: must be integer (type)",
		);
		expect(compile).toHaveBeenCalledTimes(1);

		const cached = (await readMcpCatalogCache(root.agentDir)).servers.fx;
		const connection = getMcpService().getConnection("fx");
		if (!cached || !connection) throw new Error("Missing cached fixture");
		const entries = cachedToolsToCatalogEntries("fx", cached, connection, 10_000, async () => {});
		const reloaded = buildMcpToolDefinitions(entries).find((entry) => entry.name === tool.name);
		if (!reloaded) throw new Error("Missing reloaded fixture");
		expect(validateToolArguments(reloaded, call)).toEqual({ value: 1 });
		expect(compile).toHaveBeenCalledTimes(1);

		const { connection: peer } = await connect([{ content: [], structuredContent: 1 }], false, false);
		await expect(
			callMcpToolRequest(peer.client, { name: "tool_0" }, cached.tools[0]?.outputSchema),
		).resolves.toMatchObject({ structuredContent: 1 });
		expect(compile).toHaveBeenCalledTimes(2);
		expect(new Set(compile.mock.contexts).size).toBe(1);
	});

	// Preserve senpi#4191/#4232 isolation, with refusal on use instead of compilation during cache load.
	it("refuses invalid cached input and output schemas on use without dispatching or losing valid siblings", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const root = makeRoot("invalid-schema-cache", roots);
		const { connection, script } = await connect(
			[{ content: [{ type: "text", text: "valid sibling" }] }],
			false,
			false,
		);
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
		const definitions = buildMcpToolDefinitions(entries);
		const invalidInput = definitions.find((tool) => tool.name === "mcp_fixture_invalid-input");
		const invalidOutput = entries.find((entry) => entry.tool === "invalid-output");
		const valid = entries.find((entry) => entry.tool === "valid");
		if (!invalidInput || !invalidOutput || !valid) throw new Error("Missing cached tool");
		expect(() =>
			validateToolArguments(invalidInput, {
				type: "toolCall",
				id: "invalid",
				name: invalidInput.name,
				arguments: {},
			}),
		).toThrow(expect.objectContaining({ code: "MCP_SCHEMA_INVALID" }));
		await expect(executeMcpCatalogEntry(invalidOutput, {}, undefined, undefined)).rejects.toMatchObject({
			cause: expect.objectContaining({ code: "MCP_SCHEMA_INVALID" }),
		});
		expect(script.requests).toEqual([]);
		for (const name of ["invalid-input", "invalid-output"]) {
			expect(warn).toHaveBeenCalledWith(expect.stringContaining(name));
		}
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("MCP_SCHEMA_INVALID"));
		await expect(executeMcpCatalogEntry(valid, {}, undefined, undefined)).resolves.toMatchObject({
			content: [{ type: "text", text: "valid sibling" }],
		});
		expect(script.requests.map((request) => request.params?.name)).toEqual(["valid"]);
	});

	it("retains a used schema after more than 1024 other schemas are validated", () => {
		const compile = vi.spyOn(Ajv2020.prototype, "compile");
		const original = { const: "retained-5402" };
		expect(compileModernSchema(original)("retained-5402")).toBe(true);
		for (let index = 0; index < 1025; index++) {
			expect(compileModernSchema({ const: `other-5402-${index}` })(`other-5402-${index}`)).toBe(true);
		}
		expect(compileModernSchema({ ...original })("retained-5402")).toBe(true);
		expect(compile).toHaveBeenCalledTimes(1026);
	});

	it("does not recompile an invalid schema from a fresh parse", () => {
		const compile = vi.spyOn(Ajv2020.prototype, "compile");
		const raw = JSON.stringify({ $ref: "https://example.invalid/5402/missing" });
		for (let index = 0; index < 2; index++) {
			expect(() => compileModernSchema(JSON.parse(raw))).toThrow(
				expect.objectContaining({ code: "MCP_SCHEMA_INVALID" }),
			);
		}
		expect(compile).toHaveBeenCalledTimes(1);
	});

	it("isolates nested identifiers and anchors between schemas using the same compiler", () => {
		const compile = vi.spyOn(Ajv2020.prototype, "compile");
		const schema = (value: number) => ({
			$id: "https://example.invalid/5402/root",
			$defs: { value: { $id: "value", $anchor: "item", const: value } },
			$ref: "value#item",
		});
		const first = compileModernSchema(schema(1));
		const second = compileModernSchema(schema(2));
		expect([first(1), first(2), second(1), second(2)]).toEqual([true, false, false, true]);
		expect(() => compileModernSchema({ ...schema(3), type: "bogus" })).toThrow(
			expect.objectContaining({ code: "MCP_SCHEMA_INVALID" }),
		);
		const afterFailure = compileModernSchema(schema(4));
		expect([afterFailure(3), afterFailure(4)]).toEqual([false, true]);
		expect(() => compileModernSchema({ $ref: "https://example.invalid/5402/value#item" })).toThrow(
			expect.objectContaining({ code: "MCP_SCHEMA_INVALID" }),
		);
		expect(new Set(compile.mock.contexts).size).toBe(1);
	});
});
