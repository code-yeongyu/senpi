import { createServer, type ServerResponse } from "node:http";
import { listenOnQaPort } from "./qa-port.ts";

export const MOCK_PROVIDER = "anthropic";
export const MOCK_MODEL = "mock-claude-rpc";
export const MOCK_API_KEY = "sk-ant-rpc-test";

export interface FakeModelRequest {
	readonly url: string | undefined;
	readonly model: string | undefined;
	readonly apiKeyHeader: string | undefined;
	readonly text: string;
}

export interface FakeModelServer {
	readonly origin: string;
	readonly requests: readonly FakeModelRequest[];
	close(): Promise<void>;
}

interface TextContentBlock {
	readonly type: "text";
	readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTextContentBlock(value: unknown): value is TextContentBlock {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

export function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((part) => (isTextContentBlock(part) ? part.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

export function requestText(body: unknown): string {
	if (!isRecord(body) || !Array.isArray(body.messages)) return "";
	return body.messages
		.map((message) => (isRecord(message) ? textFromContent(message.content) : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

export function responseTextFor(body: unknown): string {
	const text = requestText(body);
	const uniqueValue = /\bunique-\d+\b/.exec(text)?.[0];
	if (uniqueValue) return uniqueValue;
	if (text.includes("test123")) return "test123";
	if (/summar/i.test(text) || /compact/i.test(text)) return "Summary: the session contains the prior turns.";
	if (/\bok\b/i.test(text)) return "ok";
	if (/hello/i.test(text)) return "hello";
	return "ok";
}

function writeAnthropicSse(res: ServerResponse, text: string, model: string, multiDelta = false): void {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const send = (event: string, data: Record<string, unknown>) => {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
	};
	send("message_start", {
		message: {
			id: "msg_rpc_mock",
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	});
	send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	if (multiDelta) {
		const parts = [text.slice(0, 1), text.slice(1, 2), text.slice(2)].filter(Boolean);
		for (const part of parts) send("content_block_delta", { index: 0, delta: { type: "text_delta", text: part } });
	} else send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	send("content_block_stop", { index: 0 });
	send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
	send("message_stop", {});
	res.end();
}

export async function startFakeModelServer(options: { multiDelta?: boolean } = {}): Promise<FakeModelServer> {
	const requests: FakeModelRequest[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const body: unknown = raw ? JSON.parse(raw) : {};
			const model = isRecord(body) && typeof body.model === "string" ? body.model : undefined;
			const text = requestText(body);
			requests.push({
				url: req.url,
				model,
				apiKeyHeader: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
				text,
			});
			if (req.url?.includes("/messages")) {
				// Deterministic slow lane: prompts containing "hold-open-<ms>" keep the
				// response (and therefore the session's streaming state) open for <ms>.
				const holdOpenMs = /hold-open-(\d+)/.exec(requestText(body))?.[1];
				if (holdOpenMs) {
					// No abort listener: the response stays pending by design; the res.destroyed
					// guard keeps a late fire quiet after the client gave up.
					setTimeout(() => {
						if (!res.destroyed)
							writeAnthropicSse(res, responseTextFor(body), model ?? MOCK_MODEL, options.multiDelta);
					}, Number(holdOpenMs));
					return;
				}
				writeAnthropicSse(res, responseTextFor(body), model ?? MOCK_MODEL, options.multiDelta);
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `no route: ${req.method ?? "GET"} ${req.url ?? "/"}` } }));
		});
	});

	const port = await listenOnQaPort(server, 18998);
	return {
		origin: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolveClose, rejectClose) => {
				// `server.close()` waits for every open connection to end. The slow lane
				// holds responses open and RPC hosts keep sockets alive, so drop them
				// first or the callback never fires and teardown hangs.
				server.closeAllConnections();
				server.close((error) => {
					if (error) {
						rejectClose(error);
						return;
					}
					resolveClose();
				});
			}),
	};
}
