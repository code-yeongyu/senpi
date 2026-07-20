import { createServer, type IncomingHttpHeaders } from "node:http";
import { type Context, type Model, type Provider, streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const leak = '<invoke name="Echo"><parameter name="value">retried</parameter></invoke>';
type CapturedRequest = { readonly headers: IncomingHttpHeaders; readonly body: Record<string, unknown> };

function selectedModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "claude-alias",
		name: "Claude alias",
		api: "openai-completions",
		provider: "retry-boundary",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function parseRequestBody(raw: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected JSON request object");
	return Object.fromEntries(Object.entries(parsed));
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Local retry server did not bind to TCP");
	return `http://127.0.0.1:${address.port}/v1`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function providerFor(selected: Model<"openai-completions">, onStream: () => void): Provider {
	const run: Provider["streamSimple"] = (_model, context, options) => {
		onStream();
		const wireModel = { ...selected, id: "upstream-nonclaude-model" } satisfies Model<"openai-completions">;
		return streamSimpleOpenAICompletions(wireModel, context, options);
	};
	return {
		id: selected.provider,
		name: "Retry boundary",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }) } },
		getModels: () => [selected],
		stream: run,
		streamSimple: run,
	};
}

export function registerModelRuntimeRecoveryRetryBoundaryCase(tools: Context["tools"]): void {
	it("keeps an SDK HTTP retry inside one logical recovery wrapper and preserves selected alias activation", async () => {
		const requests: CapturedRequest[] = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requests.push({ headers: request.headers, body: parseRequestBody(Buffer.concat(chunks).toString("utf8")) });
				if (requests.length === 1) {
					response.writeHead(500, { "content-type": "application/json", "x-retry-fixture": "first" });
					response.end('{"error":{"message":"retry me"}}');
					return;
				}
				response.writeHead(200, { "content-type": "text/event-stream", "x-retry-fixture": "second" });
				response.end(
					`data: {"id":"chatcmpl-retry","choices":[{"index":0,"delta":{"content":${JSON.stringify(leak)}}}]}\n\n` +
						'data: {"id":"chatcmpl-retry","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
						"data: [DONE]\n\n",
				);
			});
		});
		const selected = selectedModel(await listen(server));
		let providerStreams = 0;
		try {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			runtime.registerNativeProvider(providerFor(selected, () => providerStreams++));
			const model = runtime.getModel(selected.provider, selected.id);
			if (!model) throw new Error("Selected alias was not registered");
			const events: string[] = [];
			const stream = runtime.streamSimple(model, { messages: [], tools }, { maxRetries: 1 });
			for await (const event of stream) events.push(event.type);
			const result = await stream.result();
			expect(model.id).toBe("claude-alias");
			expect(requests).toHaveLength(2);
			for (const captured of requests) {
				expect(captured.body).toMatchObject({ model: "upstream-nonclaude-model", stream: true });
				expect(captured.body.messages).toEqual([]);
				expect(captured.headers.authorization).toBe("Bearer test");
				expect(captured.headers["x-api-key"]).toBeUndefined();
			}
			expect(requests[0]?.body).toEqual(requests[1]?.body);
			expect(providerStreams).toBe(1);
			expect(events.filter((type) => type === "start")).toHaveLength(1);
			expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "recovered-antml-0" }));
		} finally {
			await close(server);
		}
	});

	it("does not recover when a real localhost OpenAI request disables SDK retries", async () => {
		const requests: CapturedRequest[] = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requests.push({ headers: request.headers, body: parseRequestBody(Buffer.concat(chunks).toString("utf8")) });
				response.writeHead(500, { "content-type": "application/json" });
				response.end('{"error":{"message":"no retry"}}');
			});
		});
		const selected = selectedModel(await listen(server));
		try {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			runtime.registerNativeProvider(providerFor(selected, () => {}));
			const model = runtime.getModel(selected.provider, selected.id);
			if (!model) throw new Error("Selected alias was not registered");
			const result = await runtime.streamSimple(model, { messages: [], tools }, { maxRetries: 0 }).result();
			expect(requests).toHaveLength(1);
			expect(requests[0]?.body.model).toBe("upstream-nonclaude-model");
			expect(result.stopReason).toBe("error");
			expect(result.content.some((content) => content.type === "toolCall")).toBe(false);
		} finally {
			await close(server);
		}
	});
}
