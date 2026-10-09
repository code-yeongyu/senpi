import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	AssignModelResponseSchema,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
} from "../src/api/devin-agent/gen/cascade_pb.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";

export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const USER_JWT_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
export const ASSIGN_MODEL_PATH = "/exa.api_server_pb.ApiServerService/AssignModel";
export const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";

export const MODEL = {
	id: "swe-1-6",
	name: "SWE-1.6",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 128_000,
} as unknown as Model<"devin-agent">;

export const CONTEXT: Context = {
	systemPrompt: "sys",
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
} as Context;

const servers: Server[] = [];

export async function closeStubServers(): Promise<void> {
	const closing = servers.splice(0);
	await Promise.all(closing.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}

export function frame(value: Parameters<typeof create<typeof GetChatMessageResponseSchema>>[1], gzip = false): Buffer {
	const payload = toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, value));
	const body = gzip ? gzipSync(payload) : Buffer.from(payload);
	const out = Buffer.alloc(5 + body.byteLength);
	out[0] = gzip ? 0x01 : 0x00;
	out.writeUInt32BE(body.byteLength, 1);
	out.set(body, 5);
	return out;
}

export function trailer(json = '{"metadata":{}}'): Buffer {
	const body = Buffer.from(json, "utf8");
	const out = Buffer.alloc(5 + body.byteLength);
	out[0] = 0x02;
	out.writeUInt32BE(body.byteLength, 1);
	out.set(body, 5);
	return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

export function decodeChatFrame(body: Buffer) {
	const length = body.readUInt32BE(1);
	const payload = body.subarray(5, 5 + length);
	return fromBinary(GetChatMessageRequestSchema, (body[0] ?? 0) & 0x01 ? gunzipSync(payload) : payload);
}

export interface SeenRequest {
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: Buffer;
}

export interface EdgeOptions {
	userJwt?: string;
	userJwtStatus?: number;
	customApiServerUrl?: string;
	assignment?: { modelUid: string; assignmentJwt: string };
	chat: (req: SeenRequest, res: ServerResponse) => void;
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}`;
}

/** Stub Cascade edge: GetUserJwt (+ optional AssignModel) as unary proto, then the chat stream. */
export async function serveEdge(options: EdgeOptions): Promise<{ baseUrl: string; seen: SeenRequest[] }> {
	const seen: SeenRequest[] = [];
	const baseUrl = await listen(async (req, res) => {
		const body = await readBody(req);
		const record: SeenRequest = { path: req.url ?? "", headers: req.headers, body };
		seen.push(record);
		if (record.path === USER_JWT_PATH) {
			if (options.userJwtStatus !== undefined && options.userJwtStatus !== 200) {
				res.writeHead(options.userJwtStatus, { "content-type": "application/json" });
				res.end('{"code":"unauthenticated"}');
				return;
			}
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(
				Buffer.from(
					toBinary(
						GetUserJwtResponseSchema,
						create(GetUserJwtResponseSchema, {
							userJwt: options.userJwt ?? "jwt-1",
							customApiServerUrl: options.customApiServerUrl ?? "",
						}),
					),
				),
			);
			return;
		}
		if (record.path === ASSIGN_MODEL_PATH) {
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(
				Buffer.from(
					toBinary(
						AssignModelResponseSchema,
						create(AssignModelResponseSchema, { assignment: options.assignment ?? undefined }),
					),
				),
			);
			return;
		}
		options.chat(record, res);
	});
	return { baseUrl, seen };
}

export async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const out: AssistantMessageEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

export function deltas(
	events: AssistantMessageEvent[],
	type: "text_delta" | "thinking_delta" | "toolcall_delta",
): string[] {
	return events.filter((e) => e.type === type).map((e) => (e as { delta: string }).delta);
}
