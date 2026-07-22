import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

const activeServers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		activeServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

describe("OpenAI completions stream lifecycle", () => {
	it("keeps an actively streaming response alive beyond the request establishment timeout", async () => {
		const headersReceived = Promise.withResolvers<void>();
		const startProgress = Promise.withResolvers<void>();
		const baseUrl = await startServer((response) => streamThinkingResponse(response, startProgress.promise));
		const result = streamSimple(testModel(baseUrl), userContext(), {
			apiKey: "test",
			maxRetries: 0,
			timeoutMs: 250,
			onResponse: () => headersReceived.resolve(),
		}).result();
		await headersReceived.promise;
		startProgress.resolve();
		const response = await result;

		expect(response.stopReason).toBe("stop");
		expect(response.errorMessage).toBeUndefined();
		expect(response.content).toEqual([
			{ type: "thinking", thinking: "123456789101112", thinkingSignature: "reasoning_content" },
		]);
	});

	it("still times out when response headers never arrive", async () => {
		const baseUrl = await startServer((response) => {
			setTimeout(() => streamThinkingResponse(response), 150);
		});
		const response = await streamSimple(testModel(baseUrl), userContext(), {
			apiKey: "test",
			timeoutMs: 40,
		}).result();

		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toMatch(/timed out|aborted/i);
	});

	it("rejects a real SSE stream that closes without finish_reason", async () => {
		const baseUrl = await startServer((response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-truncated",
					choices: [{ index: 0, delta: { reasoning_content: "partial" }, finish_reason: null }],
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
		const response = await streamSimple(testModel(baseUrl), userContext(), {
			apiKey: "test",
			maxRetries: 0,
		}).result();

		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("Stream ended without finish_reason");
		expect(response.content).toEqual([
			{ type: "thinking", thinking: "partial", thinkingSignature: "reasoning_content" },
		]);
	});
});

function userContext(): Context {
	return {
		messages: [{ role: "user", content: "Think for a while", timestamp: Date.now() }],
	};
}

function testModel(baseUrl: string): Model<"openai-completions"> {
	const model = getModel("openai", "gpt-4o-mini");
	if (model === undefined) throw new Error("Missing gpt-4o-mini test model");
	return { ...model, api: "openai-completions", provider: "test", baseUrl };
}

async function startServer(handle: (response: ServerResponse) => void | Promise<void>): Promise<string> {
	const server = createServer((_request, response) => {
		Promise.resolve(handle(response)).catch((error: unknown) => {
			response.destroy(error instanceof Error ? error : new Error(String(error)));
		});
	});
	activeServers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
	return `http://127.0.0.1:${address.port}/v1`;
}

async function streamThinkingResponse(
	response: ServerResponse,
	startProgress: Promise<void> = Promise.resolve(),
): Promise<void> {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	response.flushHeaders();
	await startProgress;
	for (let chunk = 1; chunk <= 12; chunk++) {
		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-active-stream",
				choices: [{ index: 0, delta: { reasoning_content: String(chunk) }, finish_reason: null }],
			})}\n\n`,
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
	}
	response.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-active-stream",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
	);
	response.end("data: [DONE]\n\n");
}
