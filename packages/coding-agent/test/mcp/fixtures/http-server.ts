import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { delaySlowStart, maybeWedge, parseFixtureOptions } from "./options.ts";
import { createFixtureServer } from "./sdk-server.ts";

interface SessionEntry {
	server: ReturnType<typeof createFixtureServer>;
	transport: StreamableHTTPServerTransport;
	expired: boolean;
	handledRequests: number;
}

async function main(): Promise<void> {
	const options = parseFixtureOptions(process.argv.slice(2));
	if (maybeWedge(options)) return;
	await delaySlowStart(options);

	const sessions = new Map<string, SessionEntry>();
	const httpServer = createServer(async (req, res) => {
		try {
			if (options.bearerToken && req.headers.authorization !== `Bearer ${options.bearerToken}`) {
				writeJson(res, 401, { error: "missing fixture bearer token" });
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, { error: "fixture only supports POST /mcp" });
				return;
			}
			if (req.url !== "/mcp") {
				writeJson(res, 404, { error: "unknown fixture route" });
				return;
			}
			const body = await readJsonBody(req);
			const entry = createOrFindSession(body, req, sessions);
			if (!entry || entry.expired) {
				writeJson(res, 404, { error: "fixture session expired" });
				return;
			}
			if (options.alwaysExpireToolCalls && isToolCallRequest(body)) {
				writeJson(res, 404, { error: "fixture tool call session expired" });
				return;
			}
			await entry.transport.handleRequest(req, res, body);
			const id = entry.transport.sessionId;
			if (id && !entry.expired) sessions.set(id, entry);
			if (isCountedSessionRequest(body)) entry.handledRequests++;
			if (options.expireSession && entry.handledRequests >= 1) {
				entry.expired = true;
				sessions.delete(entry.transport.sessionId ?? "");
			}
		} catch (error) {
			if (!res.headersSent) {
				writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			}
		}
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(options.port, "127.0.0.1", resolve);
	});
	const address = httpServer.address();
	if (!address || typeof address === "string") {
		throw new Error("fixture HTTP server did not bind to TCP");
	}
	process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp`, pid: process.pid })}\n`);

	const close = async (): Promise<void> => {
		for (const entry of sessions.values()) {
			await entry.transport.close().catch(() => undefined);
			await entry.server.close().catch(() => undefined);
		}
		httpServer.close();
	};
	process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
	process.once("SIGINT", () => void close().finally(() => process.exit(0)));
}

function createOrFindSession(
	body: unknown,
	req: IncomingMessage,
	sessions: Map<string, SessionEntry>,
): SessionEntry | null {
	const header = req.headers["mcp-session-id"];
	const sessionId = Array.isArray(header) ? header[0] : header;
	if (sessionId) return sessions.get(sessionId) ?? null;
	if (!isInitializeRequest(body)) return null;
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => `fx-${randomUUID()}` });
	const server = createFixtureServer(parseFixtureOptions(process.argv.slice(2)));
	void server.connect(transport);
	const entry: SessionEntry = { server, transport, expired: false, handledRequests: 0 };
	const id = transport.sessionId;
	if (id) sessions.set(id, entry);
	return entry;
}

function isToolCallRequest(body: unknown): boolean {
	return typeof body === "object" && body !== null && "method" in body && body.method === "tools/call";
}

function isCountedSessionRequest(body: unknown): boolean {
	return (
		typeof body === "object" &&
		body !== null &&
		"method" in body &&
		typeof body.method === "string" &&
		!body.method.startsWith("notifications/") &&
		body.method !== "initialize"
	);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			try {
				resolve(raw ? JSON.parse(raw) : undefined);
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		req.on("error", reject);
	});
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
