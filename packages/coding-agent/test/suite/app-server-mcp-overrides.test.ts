import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { materializeAppServerMcpConfigSource } from "../../src/modes/app-server/mcp-config-overrides.ts";
import {
	configureModeEnv,
	scratchRoot,
	seedFauxConfig,
	startWsAppServerMode,
	stopWsAppServerMode,
	threadIdFromResponse,
} from "./app-server-mode-harness.ts";
import { BufferedSocketReader, initializeSocket, openSocket } from "./app-server-mode-socket.ts";

describe("app-server Codex MCP config overrides", () => {
	it("uses last-wins complete valid pairs and ignores malformed or unsupported overrides", () => {
		// Given: duplicate, malformed, incomplete, and unrelated Codex overrides.
		const overrides = [
			{ key: "mcp_servers.t3-code.url", value: "https://stale.example/mcp" },
			{ key: "mcp_servers.t3-code.url", value: "http://127.0.0.1:1234/mcp" },
			{ key: "mcp_servers.t3-code.bearer_token_env_var", value: '"T3_MCP_BEARER_TOKEN"' },
			{ key: "mcp_servers.incomplete.url", value: "http://127.0.0.1:1234/mcp" },
			{ key: "mcp_servers.bad-url.url", value: "ftp://127.0.0.1/mcp" },
			{ key: "mcp_servers.bad-url.bearer_token_env_var", value: "TOKEN" },
			{ key: "mcp_servers.bad name.url", value: "http://127.0.0.1:1234/mcp" },
			{ key: "model", value: "ignored" },
		] as const;

		// When: the immutable app-server source is materialized.
		const source = materializeAppServerMcpConfigSource(overrides);

		// Then: only the final complete pair is registered and diagnostics contain no values.
		expect(source.servers).toEqual({
			"t3-code": {
				type: "http",
				url: "http://127.0.0.1:1234/mcp",
				auth: "bearer",
				bearerTokenEnv: "T3_MCP_BEARER_TOKEN",
			},
		});
		expect(source.diagnostics).toEqual([
			"ignored incomplete app-server MCP config override",
			"ignored malformed app-server MCP config override",
			"ignored unsupported app-server config override",
		]);
		expect(JSON.stringify(source.diagnostics)).not.toContain("1234");
	});

	it("authenticates a discovered tool, reloads it, reports status, and carries its result into the next model request", async () => {
		// Given: a local HTTP MCP server and faux model turn with one concrete MCP tool call.
		const root = await scratchRoot();
		const token = `test-${randomUUID()}`;
		const mcp = await startAuthenticatedMcpServer(token);
		const faux = registerFauxProvider();
		let resultReachedNextRequest = false;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp_t3-code_verify_auth", {}, { id: "mcp-auth-call" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				resultReachedNextRequest = context.messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.content.some(
							(part) => part.type === "text" && /authorizationVerified[^a-zA-Z]+true/u.test(part.text),
						),
				);
				return fauxAssistantMessage("complete");
			},
		]);
		await seedFauxConfig(root, faux);
		configureModeEnv(root);
		vi.stubEnv("T3_MCP_BEARER_TOKEN", token);
		const running = await startWsAppServerMode(18992, [
			{ key: "mcp_servers.t3-code.url", value: mcp.url },
			{ key: "mcp_servers.t3-code.bearer_token_env_var", value: '"T3_MCP_BEARER_TOKEN"' },
		]);
		const socket = await openSocket(running.port);
		const reader = new BufferedSocketReader(socket);
		try {
			await initializeSocket(socket, reader);
			socket.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root } }));
			const threadId = threadIdFromResponse(await reader.readUntilResponse(2));

			// When: T3's reload/status sequence runs and a faux turn invokes the announced tool.
			socket.send(JSON.stringify({ id: 3, method: "config/mcpServer/reload" }));
			expect(await reader.readUntilResponse(3)).toEqual({ id: 3, result: {} });
			socket.send(JSON.stringify({ id: 4, method: "mcpServerStatus/list", params: { threadId } }));
			expect(await reader.readUntilResponse(4)).toMatchObject({
				id: 4,
				result: { data: [expect.objectContaining({ name: "t3-code", authStatus: "bearerToken" })] },
			});
			socket.send(JSON.stringify({ id: 40, method: "mcpServerStatus/list", params: {} }));
			expect(await reader.readUntilResponse(40)).toMatchObject({
				id: 40,
				result: { data: [expect.objectContaining({ name: "t3-code", authStatus: "bearerToken" })] },
			});
			socket.send(
				JSON.stringify({
					id: 5,
					method: "turn/start",
					params: { threadId, input: [{ type: "text", text: "invoke configured MCP tool" }] },
				}),
			);
			const turnResponse = await reader.readUntilResponse(5);
			const completed = await reader.readUntilNotification("turn/completed");

			// Then: authorization was checked inside the fake and its sentinel reached model request two.
			expect(turnResponse).toMatchObject({ id: 5, result: { turn: { status: "inProgress" } } });
			expect(completed).toMatchObject({ method: "turn/completed", params: { turn: { status: "completed" } } });
			expect(mcp.authorizationVerified()).toBe(true);
			expect(resultReachedNextRequest).toBe(true);
			await expect(access(`${root}/${CONFIG_DIR_NAME}/mcp.json`)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(access(`${root}/agent/mcp.json`)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			reader.dispose();
			socket.close();
			faux.unregister();
			await stopWsAppServerMode(running);
			await mcp.close();
		}
	});

	it("keeps a missing bearer environment variable non-fatal and reports unauthenticated status", async () => {
		// Given: a configured bearer env name that is absent from the process.
		const root = await scratchRoot();
		const mcp = await startAuthenticatedMcpServer(`test-${randomUUID()}`);
		configureModeEnv(root);
		vi.stubEnv("MISSING_MCP_TOKEN", undefined);
		const running = await startWsAppServerMode(18993, [
			{ key: "mcp_servers.missing-auth.url", value: mcp.url },
			{ key: "mcp_servers.missing-auth.bearer_token_env_var", value: '"MISSING_MCP_TOKEN"' },
		]);
		const socket = await openSocket(running.port);
		const reader = new BufferedSocketReader(socket);
		try {
			await initializeSocket(socket, reader);

			// When: a thread attaches and its MCP status is requested.
			socket.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root } }));
			const threadId = threadIdFromResponse(await reader.readUntilResponse(2));
			socket.send(JSON.stringify({ id: 3, method: "mcpServerStatus/list", params: { threadId } }));
			const response = await reader.readUntilResponse(3);

			// Then: the server remains alive and exposes an unauthenticated entry without sending credentials.
			expect(response).toMatchObject({
				id: 3,
				result: { data: [expect.objectContaining({ name: "missing-auth", authStatus: "notLoggedIn" })] },
			});
			expect(mcp.authorizationVerified()).toBe(false);
		} finally {
			reader.dispose();
			socket.close();
			await stopWsAppServerMode(running);
			await mcp.close();
		}
	});
});

type AuthenticatedMcpServer = {
	readonly url: string;
	readonly authorizationVerified: () => boolean;
	readonly close: () => Promise<void>;
};

async function startAuthenticatedMcpServer(expectedToken: string): Promise<AuthenticatedMcpServer> {
	const sessions = new Map<string, { readonly server: Server; readonly transport: StreamableHTTPServerTransport }>();
	let verified = false;
	const httpServer = createServer(async (request, response) => {
		if (request.headers.authorization !== `Bearer ${expectedToken}`) {
			writeJson(response, 401, { error: "unauthorized" });
			return;
		}
		const body = await readJsonBody(request);
		if (isToolCall(body)) verified = true;
		const session = createOrFindMcpSession(body, request, sessions);
		if (session === undefined) {
			writeJson(response, 404, { error: "unknown session" });
			return;
		}
		await session.transport.handleRequest(request, response, body);
		const sessionId = session.transport.sessionId;
		if (sessionId !== undefined) sessions.set(sessionId, session);
	});
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(0, "127.0.0.1", resolve);
	});
	const address = httpServer.address();
	if (address === null || typeof address === "string") throw new Error("MCP test server did not bind");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		authorizationVerified: () => verified,
		close: async () => {
			for (const session of sessions.values()) {
				await session.transport.close();
				await session.server.close();
			}
			await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

function createOrFindMcpSession(
	body: unknown,
	request: IncomingMessage,
	sessions: ReadonlyMap<string, { readonly server: Server; readonly transport: StreamableHTTPServerTransport }>,
): { readonly server: Server; readonly transport: StreamableHTTPServerTransport } | undefined {
	const header = request.headers["mcp-session-id"];
	const sessionId = Array.isArray(header) ? header[0] : header;
	if (sessionId !== undefined) return sessions.get(sessionId);
	if (!isInitializeRequest(body)) return undefined;
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => `app-${randomUUID()}` });
	const server = new Server({ name: "app-server-auth-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [{ name: "verify_auth", description: "verify request auth", inputSchema: { type: "object" } }],
	}));
	server.setRequestHandler(CallToolRequestSchema, () => ({
		content: [{ type: "text", text: JSON.stringify({ authorizationVerified: true }) }],
	}));
	void server.connect(transport);
	return { server, transport };
}

function isToolCall(body: unknown): boolean {
	return typeof body === "object" && body !== null && Reflect.get(body, "method") === "tools/call";
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			try {
				const text = Buffer.concat(chunks).toString("utf8");
				resolve(text.length === 0 ? undefined : JSON.parse(text));
			} catch (error: unknown) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		request.on("error", reject);
	});
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}
