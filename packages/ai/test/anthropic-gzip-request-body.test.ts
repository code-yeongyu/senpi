import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model } from "../src/types.ts";
import { withGzipRequestBodies } from "../src/utils/gzip-request-body.ts";
import { getAnthropicCompat } from "../src/utils/prompt-cache-ttl.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface ReceivedRequest {
	readonly encoding: string | undefined;
	readonly decoded: string;
}

type Reply = (request: ReceivedRequest, index: number, response: ServerResponse) => void;

function createModel(baseUrl: string, compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		...(compat === undefined ? {} : { compat }),
	};
}

function contextWithPrompt(prompt: string): Context {
	return { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
}

async function receive(request: IncomingMessage): Promise<ReceivedRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const raw = Buffer.concat(chunks);
	const encoding = request.headers["content-encoding"];
	const decoded = (encoding === "gzip" ? gunzipSync(raw) : raw).toString("utf8");
	return { encoding, decoded };
}

function replyOk(_request: ReceivedRequest, _index: number, response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_ok" });
	response.end(
		[
			`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } } })}\n`,
			`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n"),
	);
}

function replyError(status: number, headers: Record<string, string>, message: string): Reply {
	return (_request, _index, response) => {
		response.writeHead(status, { "content-type": "application/json", ...headers });
		response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
	};
}

async function run(
	prompts: readonly string[],
	compat: Model<"anthropic-messages">["compat"],
	reply: Reply,
): Promise<{ requests: ReceivedRequest[]; stopReasons: string[] }> {
	const requests: ReceivedRequest[] = [];
	const server = createServer(async (request, response) => {
		const received = await receive(request);
		requests.push(received);
		reply(received, requests.length - 1, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const stopReasons: string[] = [];
	try {
		for (const prompt of prompts) {
			const model = createModel(`http://127.0.0.1:${port}`, compat);
			const result = await streamAnthropic(model, normalizeContext(contextWithPrompt(prompt)), {
				apiKey: "test-key",
				maxRetries: 0,
			}).result();
			stopReasons.push(result.stopReason);
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	return { requests, stopReasons };
}

const LONG = "a long session transcript line\n".repeat(400);

describe("Anthropic gzip request bodies", () => {
	it("defaults on only for the first-party Anthropic endpoint", () => {
		expect(getAnthropicCompat(createModel("https://api.anthropic.com")).supportsGzipRequestBody).toBe(true);
		expect(getAnthropicCompat(createModel("https://openrouter.ai/api")).supportsGzipRequestBody).toBe(false);
		expect(
			getAnthropicCompat(createModel("https://api.anthropic.com", { supportsGzipRequestBody: false }))
				.supportsGzipRequestBody,
		).toBe(false);
	});

	it("gzips a large body and the decoded body is the exact request JSON", async () => {
		const { requests, stopReasons } = await run([LONG], { supportsGzipRequestBody: true }, replyOk);
		expect(stopReasons).toEqual(["stop"]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.encoding).toBe("gzip");
		const body = JSON.parse(requests[0]?.decoded ?? "") as { messages: Array<{ content: unknown }> };
		expect(JSON.stringify(body.messages)).toContain(JSON.stringify(LONG).slice(1, 200));
		// Length padding is whitespace after the JSON document only.
		expect(requests[0]?.decoded.trimEnd()).toBe(JSON.stringify(body));
	});

	it("sends small bodies and opted-out providers uncompressed", async () => {
		const small = await run(["hi"], { supportsGzipRequestBody: true }, replyOk);
		expect(small.requests[0]?.encoding).toBeUndefined();
		const optedOut = await run([LONG], { supportsGzipRequestBody: false }, replyOk);
		expect(optedOut.requests[0]?.encoding).toBeUndefined();
	});

	it("resends uncompressed after a 415 and keeps that origin uncompressed", async () => {
		const reply: Reply = (request, index, response) =>
			request.encoding === "gzip"
				? replyError(415, {}, "Unsupported Media Type")(request, index, response)
				: replyOk(request, index, response);
		const { requests, stopReasons } = await run([LONG, LONG], { supportsGzipRequestBody: true }, reply);
		expect(stopReasons).toEqual(["stop", "stop"]);
		expect(requests.map((request) => request.encoding)).toEqual(["gzip", undefined, undefined]);
		expect(requests[1]?.decoded).toBe(requests[2]?.decoded);
	});

	it("resends uncompressed when the origin could not parse the gzip body as JSON", async () => {
		const reply: Reply = (request, index, response) =>
			request.encoding === "gzip"
				? replyError(400, { "request-id": "req_x" }, "The request body is not valid JSON")(request, index, response)
				: replyOk(request, index, response);
		const { requests, stopReasons } = await run([LONG], { supportsGzipRequestBody: true }, reply);
		expect(stopReasons).toEqual(["stop"]);
		expect(requests.map((request) => request.encoding)).toEqual(["gzip", undefined]);
	});

	it("resends uncompressed when a proxy in front of the API refuses the gzip body", async () => {
		const reply: Reply = (request, index, response) => {
			if (request.encoding !== "gzip") return replyOk(request, index, response);
			response.writeHead(400, { "content-type": "text/plain", "cf-ray": "8f00000000000000-NRT" });
			response.end("Bad Request");
		};
		const { requests, stopReasons } = await run([LONG], { supportsGzipRequestBody: true }, reply);
		expect(stopReasons).toEqual(["stop"]);
		expect(requests.map((request) => request.encoding)).toEqual(["gzip", undefined]);
	});

	it("keeps a Request input's own headers when it gzips the body", async () => {
		let seen: Headers | undefined;
		const wrapped = withGzipRequestBodies(async (_input, init) => {
			seen = new Headers(init?.headers);
			return new Response("{}", { status: 200 });
		});
		const request = new Request("http://127.0.0.1/v1/messages", { method: "POST", headers: { "x-api-key": "k" } });
		await wrapped(request, { method: "POST", body: LONG });
		expect(seen?.get("x-api-key")).toBe("k");
		expect(seen?.get("content-encoding")).toBe("gzip");
	});

	it("does not resend an ordinary API error", async () => {
		const reply = replyError(400, { "request-id": "req_y" }, "prompt is too long");
		const { requests, stopReasons } = await run([LONG], { supportsGzipRequestBody: true }, reply);
		expect(stopReasons).toEqual(["error"]);
		expect(requests.map((request) => request.encoding)).toEqual(["gzip"]);
	});
});
