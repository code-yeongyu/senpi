import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type ElicitRequest, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { configureMcpElicitation } from "../../src/core/extensions/builtin/mcp/elicitation.ts";
import { createMcpExtension } from "../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { cleanupRoots, fakePi, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";

const cleanup: Array<() => Promise<void>> = [];
const services: McpService[] = [];
const booleanForm: ElicitRequest = {
	method: "elicitation/create",
	params: {
		message: "Confirm operation",
		requestedSchema: { type: "object", properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] },
	},
};

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.dispose("quit")));
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await cleanupRoots(cleanup);
});

describe("headless MCP elicitation (senpi#4185)", () => {
	it.each([false, true])(
		"returns a processing error with no UI, elicitationEnabled=%s, through the real SDK",
		async (elicitationEnabled) => {
			const client = new Client(
				{ name: "client", version: "1" },
				{ capabilities: elicitationEnabled ? { elicitation: {} } : {} },
			);
			const server = new Server({ name: "server", version: "1" }, { capabilities: {} });
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await configureMcpElicitation(client, undefined, undefined, elicitationEnabled);
			await server.connect(serverTransport);
			try {
				await client.connect(clientTransport);
				const reply = Promise.withResolvers<unknown>();
				const onmessage = serverTransport.onmessage;
				serverTransport.onmessage = (message, extra) => {
					if ("id" in message && message.id === "unsolicited") reply.resolve(message);
					else onmessage?.(message, extra);
				};
				await serverTransport.send({ jsonrpc: "2.0", id: "unsolicited", ...booleanForm });
				expect(await reply.promise).toEqual({
					jsonrpc: "2.0",
					id: "unsolicited",
					error: { code: ErrorCode.InternalError, message: expect.any(String) },
				});
			} finally {
				await Promise.all([client.close(), server.close()]);
			}
		},
	);

	it.each([false, true])("uses the bound context hasUI=%s before collecting a boolean form", async (hasUI) => {
		const root = makeRoot("elicitation-ui", cleanup);
		vi.stubEnv(ENV_AGENT_DIR, root.agentDir);
		const service = new McpService();
		services.push(service);
		const extension = await loadExtensionFromFactory(
			createMcpExtension(service),
			root.cwd,
			createEventBus(),
			createExtensionRuntime(),
			"<mcp-elicitation-test>",
		);
		const ui = {
			confirm: vi.fn(async () => false),
			input: vi.fn(async () => undefined),
			select: vi.fn(async () => "No"),
		};
		for (const handler of extension.handlers.get("before_agent_start") ?? []) {
			await handler(
				{ type: "before_agent_start", systemPrompt: "", systemPromptOptions: { skills: [] } } as never,
				{ cwd: root.cwd, isProjectTrusted: () => true, hasUI, ui } as never,
			);
		}
		let handle: ((request: ElicitRequest) => Promise<unknown>) | undefined;
		const client = {
			setRequestHandler: (_schema: unknown, handler: typeof handle) => {
				handle = handler;
			},
		} as unknown as Client;
		await configureMcpElicitation(client, service);
		if (handle === undefined) throw new Error("elicitation handler was not installed");
		if (hasUI) expect(await handle(booleanForm)).toEqual({ action: "accept", content: { confirmed: false } });
		else await expect(handle(booleanForm)).rejects.toMatchObject({ code: ErrorCode.InternalError, data: undefined });
		expect(ui.confirm).not.toHaveBeenCalled();
		expect(ui.input).not.toHaveBeenCalled();
		expect(ui.select).toHaveBeenCalledTimes(hasUI ? 1 : 0);
	});

	it.each(["legacy", "modern"] as const)(
		"separates legacy mode and modern request capability over %s HTTP",
		async (era) => {
			for (const mode of ["print", "json", "tui", "rpc"] as const) {
				const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
				vi.stubGlobal(
					"fetch",
					vi.fn(async (_url: unknown, init?: RequestInit) => {
						if (init?.method !== "POST") return new Response(null, { status: 405 });
						const request = JSON.parse(String(init.body));
						if (!request.method || request.id === undefined) return new Response(null, { status: 202 });
						requests.push(request);
						if (request.method === "server/discover") {
							return Response.json(
								era === "modern"
									? {
											jsonrpc: "2.0",
											id: request.id,
											result: {
												resultType: "complete",
												supportedVersions: ["2026-07-28"],
												capabilities: { tools: {} },
												_meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
											},
										}
									: { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } },
							);
						}
						const result =
							request.method === "initialize"
								? {
										protocolVersion: "2025-11-25",
										capabilities: { tools: {} },
										serverInfo: { name: "fixture", version: "1" },
									}
								: request.method === "tools/list"
									? { tools: [] }
									: {};
						return Response.json({ jsonrpc: "2.0", id: request.id, result });
					}),
				);
				const root = makeRoot(`elicitation-${era}-${mode}`, cleanup);
				setConfig(root, {
					fixture: { type: "http", url: "https://example.test/mcp", auth: false, lifecycle: "eager" },
				});
				const service = new McpService();
				services.push(service);
				await service.attachSession(
					{ type: "session_start", reason: "startup" },
					{ cwd: root.cwd, isProjectTrusted: () => true, mode },
					fakePi(),
					{ agentDir: root.agentDir },
				);
				expect(await service.whenAttachSettled(10_000)).toBe("settled");
				expect(service.getConnection("fixture")?.state).toBe("connected");
				// Modern discovery/catalog has no issuing human, regardless of a process mode label.
				const expected = era === "modern" || mode === "print" || mode === "json" ? {} : { elicitation: {} };
				if (era === "legacy") {
					const initialize = requests.find((request) => request.method === "initialize");
					expect(initialize?.params.capabilities).toEqual(expected);
				} else {
					expect(requests.some((request) => request.method === "server/discover")).toBe(true);
					expect(requests.some((request) => request.method === "tools/list")).toBe(true);
					for (const request of requests) {
						expect(request.params._meta).toMatchObject({
							"io.modelcontextprotocol/clientCapabilities": expected,
						});
						expect(
							(request.params._meta as Record<string, unknown>)["io.modelcontextprotocol/clientCapabilities"],
						).toEqual(expected);
					}
				}
				await service.dispose("quit");
			}
		},
	);
});
