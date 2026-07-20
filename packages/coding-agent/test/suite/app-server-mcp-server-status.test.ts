import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, getModel, type Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";
import {
	createMcpWireStatusAdapter,
	type McpWireStatusServer,
} from "../../src/modes/app-server/threads/mcp-wire-status.ts";
import { ThreadRegistry, type ThreadRegistryOptions } from "../../src/modes/app-server/threads/registry.ts";

type SentMessage = RpcEnvelope;

describe("app-server mcpServerStatus/list", () => {
	it("selects each loaded thread adapter, merges configured servers, and filters detail", async () => {
		// Given: two loaded threads with distinct MCP inventories and a process-scope fallback.
		const root = await mkdtemp(join(tmpdir(), "senpi-app-server-mcp-status-"));
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		const firstAdapter = createMcpWireStatusAdapter({
			servers: [connectedServer("alpha", "bearerToken"), unconnectedServer("alpha-offline", "notLoggedIn")],
		});
		const secondAdapter = createMcpWireStatusAdapter({ servers: [connectedServer("beta", "oAuth")] });
		const globalAdapter = createMcpWireStatusAdapter({ servers: [unconnectedServer("global", "unsupported")] });
		const adaptersByCwd = new Map([
			[firstCwd, firstAdapter],
			[secondCwd, secondAdapter],
		]);
		const requestedModel: Model<Api> = getModel("openai", "gpt-5");
		const createSession: ThreadRegistryOptions["createSession"] = async (options) => {
			const adapter = options.cwd === undefined ? undefined : adaptersByCwd.get(options.cwd);
			if (adapter === undefined) throw new Error(`Missing MCP test adapter for ${options.cwd ?? "<unset cwd>"}`);
			const result = await createAgentSession({
				...options,
				model: options.model ?? requestedModel,
				autoTitleSessions: false,
			});
			return { ...result, mcpWireStatusAdapter: adapter };
		};
		const threads = new ThreadRegistry({
			agentDir: join(root, "agent"),
			sessionDir: join(root, "sessions"),
			createSession,
			mcpWireStatusAdapter: globalAdapter,
		});

		try {
			await mkdir(firstCwd, { recursive: true });
			await mkdir(secondCwd, { recursive: true });
			const firstThread = await threads.createThread({ cwd: firstCwd });
			const secondThread = await threads.createThread({ cwd: secondCwd });
			const current = createCore(threads);
			await initialize(current.core, current.id);

			// When: the client requests the first thread's complete first page.
			await current.core.receive(
				current.id,
				request(2, "mcpServerStatus/list", { threadId: firstThread.id, detail: "full", limit: 1 }),
			);

			// Then: connected metadata and configured-but-unconnected servers are preserved and paginated numerically.
			expect(resultOf(current.sent[1])).toEqual({
				data: [
					{
						name: "alpha",
						serverInfo: {
							name: "alpha",
							title: null,
							version: "1.0.0",
							description: null,
							icons: null,
							websiteUrl: null,
						},
						tools: { search: { name: "search", inputSchema: { type: "object" } } },
						resources: [{ name: "alpha-resource", uri: "alpha://resource" }],
						resourceTemplates: [{ name: "alpha-template", uriTemplate: "alpha://{id}" }],
						authStatus: "bearerToken",
					},
				],
				nextCursor: "1",
			});

			await current.core.receive(
				current.id,
				request(3, "mcpServerStatus/list", {
					threadId: firstThread.id,
					detail: "toolsAndAuthOnly",
					limit: 2,
				}),
			);
			expect(resultOf(current.sent[2])).toEqual({
				data: [
					{
						name: "alpha",
						serverInfo: null,
						tools: { search: { name: "search", inputSchema: { type: "object" } } },
						resources: [],
						resourceTemplates: [],
						authStatus: "bearerToken",
					},
					{
						name: "alpha-offline",
						serverInfo: null,
						tools: {},
						resources: [],
						resourceTemplates: [],
						authStatus: "notLoggedIn",
					},
				],
				nextCursor: null,
			});

			await current.core.receive(
				current.id,
				request(4, "mcpServerStatus/list", { threadId: secondThread.id, detail: "full" }),
			);
			expect(resultOf(current.sent[3])).toEqual({
				data: [expect.objectContaining({ name: "beta", authStatus: "oAuth" })],
				nextCursor: null,
			});

			await current.core.receive(current.id, request(5, "mcpServerStatus/list", {}));
			expect(resultOf(current.sent[4])).toEqual({
				data: [expect.objectContaining({ name: "global", authStatus: "unsupported" })],
				nextCursor: null,
			});

			await current.core.receive(
				current.id,
				request(6, "mcpServerStatus/list", { threadId: "missing-loaded-thread" }),
			);
			expect(current.sent[5]).toEqual({
				id: 6,
				error: { code: -32600, message: expect.stringContaining("mcpServerStatus/list") },
			});
		} finally {
			for (const thread of threads.listLoaded()) threads.unloadThread(thread.id);
			await rm(root, { recursive: true, force: true });
		}
	});
});

function createCore(threads: ThreadRegistry): {
	readonly core: ServerCore;
	readonly sent: SentMessage[];
	readonly id: string;
} {
	const core = new ServerCore({
		codexHome: "/tmp/senpi-app-server-mcp-status-home",
		serverCwd: "/tmp/senpi-app-server-mcp-status",
		threads,
		version: "2026.7.2",
	});
	const sent: SentMessage[] = [];
	const connection = core.addConnection({
		id: "mcp-status-test",
		transportKind: "stdio",
		send: (message) => {
			sent.push(message);
		},
		close: () => undefined,
	});
	return { core, sent, id: connection.id };
}

async function initialize(core: ServerCore, id: string): Promise<void> {
	await core.receive(
		id,
		request(1, "initialize", {
			clientInfo: { name: "mcp-status-test", title: "MCP Status Test", version: "0.0.1" },
			capabilities: { experimentalApi: false, requestAttestation: false },
		}),
	);
}

function request(
	id: number,
	method: string,
	params: unknown,
): {
	readonly kind: "request";
	readonly message: { readonly id: number; readonly method: string; readonly params: unknown };
} {
	return { kind: "request", message: { id, method, params } };
}

function resultOf(message: SentMessage | undefined): unknown {
	expect(message).toEqual({ id: expect.anything(), result: expect.anything() });
	if (message !== undefined && "result" in message) return message.result;
	throw new Error("expected successful app-server response");
}

function connectedServer(name: string, authStatus: McpWireStatusServer["authStatus"]): McpWireStatusServer {
	return {
		name,
		serverInfo: {
			name,
			title: null,
			version: "1.0.0",
			description: null,
			icons: null,
			websiteUrl: null,
		},
		tools: [{ name: "search", inputSchema: { type: "object" } }],
		resources: [{ name: `${name}-resource`, uri: `${name}://resource` }],
		resourceTemplates: [{ name: `${name}-template`, uriTemplate: `${name}://{id}` }],
		authStatus,
	};
}

function unconnectedServer(name: string, authStatus: McpWireStatusServer["authStatus"]): McpWireStatusServer {
	return {
		name,
		serverInfo: null,
		tools: [],
		resources: [],
		resourceTemplates: [],
		authStatus,
	};
}
