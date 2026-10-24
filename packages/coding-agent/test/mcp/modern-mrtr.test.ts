import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeServer } from "../../src/core/extensions/builtin/mcp/config.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpRequestOrigin, mcpRequestOptions } from "../../src/core/extensions/builtin/mcp/request-origin.ts";
import { getMcpMrtrPresentation } from "../../src/core/mcp-mrtr-presentations.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { inputResult, MrtrScript, startMrtrServer } from "./fixtures/mrtr-2026-server.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(results: unknown[], sse: boolean | "stdio" = false, human = true) {
	const script = new MrtrScript(results);
	const server = await startMrtrServer(script, sse === true);
	cleanups.push(server.close);
	const root = await mkdtemp(join(tmpdir(), "mrtr-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const logger = createMcpLogger("fixture", { logDir: root });
	const connection = new ServerConnection({
		serverName: "fixture",
		config: normalizeServer(
			sse === "stdio"
				? {
						type: "stdio",
						command: process.execPath,
						args: [
							"--import",
							"tsx",
							fileURLToPath(new URL("./fixtures/mrtr-2026-server.ts", import.meta.url)),
							JSON.stringify(results),
						],
						auth: false,
					}
				: { type: "http", url: server.url, auth: false },
		),
		logger,
	});
	await connection.connect();
	cleanups.push(() => connection.dispose());
	const host = Object.create(InteractiveMode.prototype);
	Object.defineProperty(host, "session", { value: { emitExtensionEvent() {} } });
	host.showExtensionSelector = async (_title: string, choices: string[]) =>
		choices.includes("Submit") ? "Submit" : choices[0];
	host.showExtensionInput = async () => "human answer";
	const ui = host.createExtensionUIContext();
	const origin = createMcpRequestOrigin({
		binding: {},
		connection,
		signal: connection.requestLifetimeSignal,
		presentation: human ? getMcpMrtrPresentation(ui) : undefined,
		serverLabel: "fixture",
		isCurrent: () => connection.state === "connected",
		resolveAuthority: async () => null,
	});
	const physical = connection.client;
	const client = new Proxy(physical, {
		get(target, property) {
			if (property === "callTool")
				return (...args: Parameters<Client["callTool"]>) =>
					target.callTool(args[0], args[1], mcpRequestOptions(origin, args[2]));
			if (property === "readResource")
				return (...args: Parameters<Client["readResource"]>) =>
					target.readResource(args[0], mcpRequestOptions(origin, args[1]));
			if (property === "getPrompt")
				return (...args: Parameters<Client["getPrompt"]>) =>
					target.getPrompt(args[0], mcpRequestOptions(origin, args[1]));
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { client, script, origin, physical, connection, host, logger };
}

describe("modern MRTR adapter", () => {
	it.each([false, true])(
		"tools/call waits for input_required then returns only complete content (SSE=%s)",
		async (sse) => {
			const { client, script } = await connect([inputResult()], sse);
			const result = await client.callTool({ name: "fixture", arguments: { value: 1 } });
			expect(result.content).toEqual([{ type: "text", text: "final tool" }]);
			expect(script.requests).toHaveLength(2);
			expect(script.requests[1]?.id).not.toBe(script.requests[0]?.id);
			expect(script.requests[1]?.params).toMatchObject({
				name: "fixture",
				arguments: { value: 1 },
				requestState: " opaque \u2603 state ",
				inputResponses: { question: { action: "accept", content: { value: "human answer" } } },
			});
			expect(script.requests[0]?.params).toHaveProperty(["_meta", "io.modelcontextprotocol/clientCapabilities"], {
				elicitation: {},
			});
		},
	);
	it("resources/read completes MRTR before flattening contents", async () => {
		const { client, script } = await connect([inputResult()]);
		expect((await client.readResource({ uri: "test://resource" })).contents).toEqual([
			{ uri: "test://resource", text: "final resource" },
		]);
		expect(script.requests).toHaveLength(2);
	});
	it("prompts/get completes MRTR before changing the editor", async () => {
		const { client, script } = await connect([inputResult()]);
		expect((await client.getPrompt({ name: "fixture" })).messages[0]?.content).toEqual({
			type: "text",
			text: "final prompt",
		});
		expect(script.requests).toHaveLength(2);
	});
	it("each round replaces state and responses instead of merging", async () => {
		const { client, script } = await connect([
			inputResult("S1"),
			{ resultType: "input_required", inputRequests: {} },
			{ resultType: "input_required", requestState: "" },
		]);
		await client.callTool({ name: "fixture" });
		expect(script.requests).toHaveLength(4);
		expect(script.requests[2]?.params).toHaveProperty("inputResponses", {});
		expect(script.requests[2]?.params).not.toHaveProperty("requestState");
		expect(script.requests[3]?.params).toHaveProperty("requestState", "");
		expect(script.requests[3]?.params).not.toHaveProperty("inputResponses");
	});
	it("eight input rounds permit nine attempts and then stop", async () => {
		const { client, script } = await connect(Array.from({ length: 9 }, () => inputResult()));
		await expect(client.callTool({ name: "fixture" })).rejects.toMatchObject({ code: "MCP_MRTR_ROUND_LIMIT" });
		expect(script.requests).toHaveLength(9);
	});
	it.each(["task", "unknown", null, 1])(
		"unsupported result types never become empty success (%s)",
		async (resultType) => {
			const { client } = await connect([{ resultType }]);
			await expect(client.callTool({ name: "fixture" })).rejects.toMatchObject({ code: "MCP_MRTR_INVALID_RESULT" });
		},
	);
	it.each([
		{ resultType: "input_required" },
		{ resultType: "input_required", requestState: 1 },
		{ resultType: "input_required", inputRequests: [] },
		{ resultType: "complete", requestState: "private" },
	])("malformed input is rejected before UI (%j)", async (intermediate) => {
		const { client } = await connect([intermediate]);
		await expect(client.callTool({ name: "fixture" })).rejects.toMatchObject({ source: "local", retriable: false });
	});
	it.each(["roots/list", "sampling/createMessage"])(
		"undeclared %s stops locally without fabricated results",
		async (method) => {
			const { client, script } = await connect([inputResult("state", { input: { method, params: {} } })]);
			await expect(client.callTool({ name: "fixture" })).rejects.toMatchObject({
				code: "MCP_MRTR_UNSUPPORTED_INPUT",
			});
			expect(script.requests).toHaveLength(1);
		},
	);
	it("server input keys cannot mutate object prototypes", async () => {
		const form = {
			method: "elicitation/create",
			params: { message: "question", requestedSchema: { type: "object", properties: {} } },
		};
		const inputs = Object.fromEntries(["__proto__", "constructor", "toString"].map((key) => [key, form]));
		const { client, script } = await connect([inputResult("state", inputs)]);
		await client.callTool({ name: "fixture" });
		expect(script.requests).toHaveLength(2);
		expect(Object.keys(script.requests[1]?.params?.inputResponses as object)).toEqual([
			"__proto__",
			"constructor",
			"toString",
		]);
	});
	it("no human terminates locally without decline or a retry", async () => {
		const { client, script } = await connect([inputResult()], false, false);
		await expect(client.callTool({ name: "fixture" })).rejects.toMatchObject({ code: "MCP_MRTR_UNSUPPORTED_INPUT" });
		expect(script.requests).toHaveLength(1);
		expect(script.requests[0]?.params).toHaveProperty(["_meta", "io.modelcontextprotocol/clientCapabilities"], {});
	});
	it("stdio uses the same continuation contract", async () => {
		const { client, logger } = await connect([inputResult()], "stdio");
		expect((await client.callTool({ name: "fixture" })).content).toEqual([{ type: "text", text: "final tool" }]);
		expect(logger.getRingBuffer().join("\n")).not.toContain("PRIVATE_STDERR_CANARY");
	});
	it("modern diagnostic messages are suppressed before consent reaches the logger", async () => {
		const { client, script, logger } = await connect([inputResult()], true);
		script.notifications.push({
			jsonrpc: "2.0",
			method: "notifications/message",
			params: {
				level: "warning",
				data: "PRIVATE_SERVER_LOG_CANARY",
				logger: "PRIVATE_LOGGER_CANARY",
			},
		});
		await client.callTool({ name: "fixture" });
		expect(logger.getRingBuffer().join("\n")).not.toContain("CANARY");
	});
	it.each(["resources/list", "resources/templates/list", "prompts/list", "tools/list", "completion/complete"])(
		"input_required is rejected on noncapable %s",
		async (method) => {
			const { physical, script } = await connect([inputResult()]);
			script.methods.add(method);
			await expect(physical.request({ method, params: {} }, ResultSchema)).rejects.toMatchObject({
				code: "MCP_MRTR_INVALID_RESULT",
			});
			expect(script.requests).toHaveLength(1);
		},
	);
	it.each([true, false])("tools/call validates outputSchema only after complete (valid=%s)", async (valid) => {
		const { client, script } = await connect([
			inputResult(),
			{ content: [], structuredContent: { value: valid ? 42 : "invalid" } },
		]);
		script.outputSchema = { type: "object", properties: { value: { type: "number" } }, required: ["value"] };
		await client.listTools();
		const call = client.callTool({ name: "fixture" });
		if (valid) expect(await call).toHaveProperty("structuredContent", { value: 42 });
		else await expect(call).rejects.toThrow();
		expect(script.requests).toHaveLength(2);
	});
	it.each([
		{ resultType: "input_required", requestState: "x".repeat(65537) },
		inputResult(
			"state",
			Object.fromEntries(
				Array.from({ length: 33 }, (_, index) => [
					String(index),
					{
						method: "elicitation/create",
						params: { message: "test", requestedSchema: { type: "object", properties: {} } },
					},
				]),
			),
		),
		inputResult("state", {
			value: {
				method: "elicitation/create",
				params: { message: "x".repeat(16385), requestedSchema: { type: "object", properties: {} } },
			},
		}),
	])("oversized input is rejected before UI", async (result) => {
		const { client } = await connect([result]);
		await expect(client.callTool({ name: "fixture" })).rejects.toMatchObject({ code: "MCP_MRTR_INPUT_LIMIT" });
	});
	it("caller continuation fields cannot be reused by an application retry", async () => {
		const { physical, script } = await connect([]);
		await expect(
			physical.request(
				{ method: "tools/call", params: { name: "fixture", requestState: "injected" } },
				ResultSchema,
			),
		).rejects.toMatchObject({ code: "MCP_MRTR_INVALID_INPUT" });
		expect(script.requests).toHaveLength(0);
	});
	it("unsolicited URL inputs terminate without navigation or fabricated decline", async () => {
		const { client, script, host } = await connect([
			inputResult("state", {
				url: {
					method: "elicitation/create",
					params: {
						mode: "url",
						message: "private",
						url: "https://invalid.test",
						elicitationId: "id",
					},
				},
			}),
		]);
		let shown = false;
		host.showExtensionSelector = async () => {
			shown = true;
			return "Continue";
		};
		await expect(client.callTool({ name: "fixture" })).rejects.toMatchObject({ code: "MCP_MRTR_UNSUPPORTED_INPUT" });
		expect(shown).toBe(false);
		expect(script.requests).toHaveLength(1);
	});
});
