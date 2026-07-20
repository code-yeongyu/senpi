import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

interface RequestBody {
	messages?: Array<{
		role: string;
		content: Array<{ type: string; text?: string; thinking?: string; signature?: string }>;
	}>;
}

function createModel(baseUrl: string, compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "kimi-k3",
		name: "Kimi K3",
		api: "anthropic-messages",
		provider: "kimi-coding",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { allowEmptySignature: true, ...compat },
	};
}

function createContext(): Context {
	const previousAssistant: AssistantMessage = {
		role: "assistant",
		api: "anthropic-messages",
		provider: "kimi-coding",
		model: "kimi-k3",
		content: [
			{ type: "thinking", thinking: "unsigned replayed thought", thinkingSignature: "" },
			{ type: "toolCall", id: "toolu_1", name: "lookup", arguments: {} },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return {
		messages: [
			{ role: "user", content: "Use lookup", timestamp: Date.now() },
			previousAssistant,
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "lookup",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	};
}

async function readBody(request: IncomingMessage): Promise<RequestBody> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
}

function writeEmptySse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

function writeError(response: ServerResponse, message: string): void {
	response.writeHead(400, { "content-type": "application/json" });
	response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
}

function writeInvalidSignature(response: ServerResponse): void {
	writeError(response, "Invalid signature in thinking block");
}

function writeStartedSseThenError(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
	);
	response.end('event: error\ndata: {"type":"error","error":{"message":"Invalid signature in thinking block"}}\n\n');
}

async function run(model: Model<"anthropic-messages">, sessionId: string) {
	const response = streamAnthropic(model, createContext(), { apiKey: "test-key", cacheRetention: "none", sessionId });
	for await (const event of response) {
		if (event.type === "done" || event.type === "error") break;
	}
	return response.result();
}

describe("Anthropic unsigned thinking replay fallback", () => {
	it("retries an invalid unsigned thinking signature once, then caches text replay for the session", async () => {
		const requests: RequestBody[] = [];
		const server = createServer(async (request, response) => {
			requests.push(await readBody(request));
			if (requests.length === 1) {
				writeInvalidSignature(response);
			} else {
				writeEmptySse(response);
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		const model = createModel(`http://127.0.0.1:${address.port}`);

		try {
			await run(model, "session-a");
			await run(model, "session-a");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}

		expect(requests).toHaveLength(3);
		const firstThinking = requests[0].messages?.[1]?.content[0];
		const retriedThinking = requests[1].messages?.[1]?.content[0];
		const cachedThinking = requests[2].messages?.[1]?.content[0];
		expect(firstThinking).toEqual({ type: "thinking", thinking: "unsigned replayed thought", signature: "" });
		expect(retriedThinking).toEqual({ type: "text", text: "unsigned replayed thought" });
		expect(cachedThinking).toEqual({ type: "text", text: "unsigned replayed thought" });
	});

	it("uses explicit text replay policy while preserving Kimi's legacy empty signatures", async () => {
		const requests: RequestBody[] = [];
		const server = createServer(async (request, response) => {
			requests.push(await readBody(request));
			writeEmptySse(response);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;

		try {
			await run(createModel(baseUrl, { unsignedThinkingReplay: "text" }), "signing-session");
			await run(createModel(baseUrl), "kimi-session");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}

		expect(requests[0].messages?.[1]?.content[0]).toEqual({ type: "text", text: "unsigned replayed thought" });
		expect(requests[1].messages?.[1]?.content[0]).toEqual({
			type: "thinking",
			thinking: "unsigned replayed thought",
			signature: "",
		});
	});

	it("does not retry unrelated 400 responses", async () => {
		let requestCount = 0;
		const server = createServer((_request, response) => {
			requestCount += 1;
			writeError(response, "A different invalid request");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;

		try {
			const result = await run(createModel(`http://127.0.0.1:${address.port}`), "unrelated-session");
			expect(result.stopReason).toBe("error");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}

		expect(requestCount).toBe(1);
	});

	it("does not retry a signature error after content has started", async () => {
		let requestCount = 0;
		const server = createServer((_request, response) => {
			requestCount += 1;
			writeStartedSseThenError(response);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;

		try {
			const result = await run(createModel(`http://127.0.0.1:${address.port}`), "post-content-session");
			expect(result.stopReason).toBe("error");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}

		expect(requestCount).toBe(1);
	});
});
