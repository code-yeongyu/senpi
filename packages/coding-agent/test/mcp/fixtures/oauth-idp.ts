// Standalone OAuth 2.1 fixture identity provider + MCP protected resource.
// Spawned as a child process by the auth tests; prints a JSON readiness line
// {url, mcpUrl, pid}. Routing is thin; all OAuth logic lives in oauth-idp-core.ts.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type HttpReply, IdpState, parseIdpOptions } from "./oauth-idp-core.ts";
import { parseFixtureOptions } from "./options.ts";
import { createFixtureServer } from "./sdk-server.ts";

interface McpSession {
	server: ReturnType<typeof createFixtureServer>;
	transport: StreamableHTTPServerTransport;
}

async function main(): Promise<void> {
	const state = new IdpState(parseIdpOptions(process.argv.slice(2)));
	const mcpSessions = new Map<string, McpSession>();
	const server = createServer((req, res) => {
		void handle(req, res, state, mcpSessions).catch((error: unknown) => {
			if (!res.headersSent) writeReply(res, { status: 500, body: { error: String(error) } });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("idp did not bind TCP");
	state.baseUrl = `http://127.0.0.1:${address.port}`;
	process.stdout.write(
		`${JSON.stringify({ url: state.baseUrl, mcpUrl: `${state.baseUrl}/mcp`, pid: process.pid })}\n`,
	);
	const close = (): void => {
		for (const session of mcpSessions.values()) void session.transport.close().catch(() => undefined);
		server.close();
	};
	process.once("SIGTERM", () => close());
	process.once("SIGINT", () => close());
}

async function handle(
	req: IncomingMessage,
	res: ServerResponse,
	state: IdpState,
	mcpSessions: Map<string, McpSession>,
): Promise<void> {
	const url = new URL(req.url ?? "/", state.baseUrl);
	const path = url.pathname;
	if (path.startsWith("/.well-known/oauth-protected-resource"))
		return writeReply(res, state.protectedResourceMetadata());
	if (path.startsWith("/.well-known/oauth-authorization-server")) {
		return writeReply(res, state.authorizationServerMetadata("oauth"));
	}
	if (path.startsWith("/.well-known/openid-configuration")) {
		return writeReply(res, state.authorizationServerMetadata("oidc"));
	}
	if (path === "/cimd") return writeReply(res, state.clientMetadataDocument());
	if (path === "/authorize") return writeReply(res, state.authorize(url.searchParams));
	if (path === "/register") return writeReply(res, state.register(await readJson(req)));
	if (path === "/token") return writeReply(res, state.token(await readForm(req)));
	if (path === "/__log") return writeReply(res, { status: 200, body: logSnapshot(state) });
	if (path === "/mcp") return handleMcp(req, res, state, mcpSessions);
	writeReply(res, { status: 404, body: { error: "not_found", path } });
}

function logSnapshot(state: IdpState): Record<string, unknown> {
	return {
		requests: state.requests,
		tokenHits: state.tokenHits,
		registerHits: state.registerHits,
		discoveryHits: state.discoveryHits,
		familyInvalidated: state.familyInvalidated,
	};
}

async function handleMcp(
	req: IncomingMessage,
	res: ServerResponse,
	state: IdpState,
	mcpSessions: Map<string, McpSession>,
): Promise<void> {
	const auth = req.headers.authorization;
	const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
	if (token === undefined || !state.isAccessTokenValid(token)) {
		res.writeHead(401, {
			"content-type": "application/json",
			"www-authenticate": `Bearer resource_metadata="${state.baseUrl}/.well-known/oauth-protected-resource"`,
		});
		res.end(JSON.stringify({ error: "invalid_token" }));
		return;
	}
	state.log({ method: req.method ?? "POST", path: "/mcp", note: "authorized" });
	const body = await readJson(req);
	const header = req.headers["mcp-session-id"];
	const sessionId = Array.isArray(header) ? header[0] : header;
	const existing = sessionId === undefined ? undefined : mcpSessions.get(sessionId);
	if (existing !== undefined) {
		await existing.transport.handleRequest(req, res, body);
		return;
	}
	if (!isInitializeRequest(body)) {
		writeReply(res, { status: 404, body: { error: "no session" } });
		return;
	}
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => `idp-${randomUUID()}` });
	const mcpServer = createFixtureServer(parseFixtureOptions([]));
	await mcpServer.connect(transport);
	await transport.handleRequest(req, res, body);
	if (transport.sessionId !== undefined) mcpSessions.set(transport.sessionId, { server: mcpServer, transport });
}

function writeReply(res: ServerResponse, reply: HttpReply): void {
	if (reply.redirect !== undefined) {
		res.writeHead(reply.status, { location: reply.redirect });
		res.end();
		return;
	}
	res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
	res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const raw = await readBody(req);
	if (raw.length === 0) return {};
	return JSON.parse(raw) as Record<string, unknown>;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
	return new URLSearchParams(await readBody(req));
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
