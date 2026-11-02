import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSessionTitle } from "../../../src/core/session-title-generator.ts";

// Regression for #2163 and #1266: the mock mirrors OpenRouter's mandatory-reasoning contract.

const MANDATORY_MESSAGE = "Reasoning is mandatory for this endpoint and cannot be disabled.";
const TITLE_PROMPT = "Fix the login bug in the auth service";

interface RecordedRequest {
	readonly model: string;
	readonly maxTokens: number | undefined;
	readonly reasoningEffort: string | undefined;
	readonly zaiReasoningEffort: string | undefined;
	readonly zaiThinking: string | undefined;
}

interface MockEndpoint {
	readonly baseUrl: string;
	readonly requests: RecordedRequest[];
	close(): Promise<void>;
}

interface MockOptions {
	readonly mandatoryReasoning: boolean;
	readonly failure?: { status: number; message: string };
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>));
		request.on("error", reject);
	});
}

function writeTitleStream(response: ServerResponse, model: string): void {
	const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
		`data: ${JSON.stringify({
			id: "chatcmpl-title",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})}\n\n`;
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(chunk({ role: "assistant", content: "<title>Fix Login Bug</title>" }, null));
	response.write(chunk({}, "stop"));
	response.end("data: [DONE]\n\n");
}

async function startMockEndpoint(options: MockOptions): Promise<MockEndpoint> {
	const requests: RecordedRequest[] = [];
	const server = createServer(async (request, response) => {
		const body = await readJson(request);
		const reasoning = body.reasoning as { effort?: string } | undefined;
		const thinking = body.thinking as { type?: string } | undefined;
		const model = String(body.model);
		requests.push({
			model,
			maxTokens: (body.max_completion_tokens ?? body.max_tokens) as number | undefined,
			reasoningEffort: reasoning?.effort,
			zaiReasoningEffort: body.reasoning_effort as string | undefined,
			zaiThinking: thinking?.type,
		});
		if (options.failure !== undefined) {
			response.writeHead(options.failure.status, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: options.failure.message, code: options.failure.status } }));
			return;
		}
		if (options.mandatoryReasoning && reasoning?.effort === "none") {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: MANDATORY_MESSAGE, code: 400 } }));
			return;
		}
		writeTitleStream(response, model);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function openRouterModel(id: string, baseUrl: string, thinkingLevelMap?: ThinkingLevelMap): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl,
		reasoning: true,
		...(thinkingLevelMap && { thinkingLevelMap }),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 32_000,
		compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
	} as Model<Api>;
}

function titleFor(model: Model<Api>): Promise<string | undefined> {
	return generateSessionTitle({
		firstPrompt: TITLE_PROMPT,
		model,
		auth: { apiKey: "test-key" },
		sessionId: "issue-2163",
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
	});
}

describe("issue #2163: session titles on endpoints that mandate reasoning", () => {
	let endpoint: MockEndpoint | undefined;

	beforeEach(() => {
		endpoint = undefined;
	});

	afterEach(async () => {
		await endpoint?.close();
	});

	it("asks for the lowest supported level when the catalog says reasoning cannot be disabled (OpenRouter muse-spark)", async () => {
		endpoint = await startMockEndpoint({ mandatoryReasoning: true });
		// Shape `getOpenRouterThinkingLevelMap()` produces from OpenRouter's
		// `reasoning: { mandatory: true, supported_efforts: [max..minimal] }`.
		const model = openRouterModel("meta/muse-spark-1.3-contributor", endpoint.baseUrl, {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});

		await expect(titleFor(model)).resolves.toBe("Fix Login Bug");

		expect(endpoint.requests).toHaveLength(1);
		expect(endpoint.requests[0]?.reasoningEffort).toBe("minimal");
		expect(endpoint.requests[0]?.maxTokens).toBeGreaterThan(64);
	});

	it("retries once with low reasoning when a stale catalog entry hits the mandatory 400 (OpenRouter muse-spark)", async () => {
		endpoint = await startMockEndpoint({ mandatoryReasoning: true });
		const model = openRouterModel("meta/muse-spark-1.3-contributor", endpoint.baseUrl);

		await expect(titleFor(model)).resolves.toBe("Fix Login Bug");

		expect(endpoint.requests.map((request) => request.reasoningEffort)).toEqual(["none", "low"]);
		expect(endpoint.requests[1]?.maxTokens).toBeGreaterThan(64);
	});

	it("retries once with low reasoning for Z.ai GLM 5.3 Flash routed through OpenRouter", async () => {
		endpoint = await startMockEndpoint({ mandatoryReasoning: true });
		const model = openRouterModel("z-ai/glm-5.3-flash", endpoint.baseUrl);

		await expect(titleFor(model)).resolves.toBe("Fix Login Bug");

		expect(endpoint.requests.map((request) => request.reasoningEffort)).toEqual(["none", "low"]);
	});

	it("asks Z.ai GLM 5.3 for its lowest supported effort instead of the endpoint default", async () => {
		endpoint = await startMockEndpoint({ mandatoryReasoning: false });
		const model = {
			...openRouterModel("glm-5.3", endpoint.baseUrl, {
				off: null,
				minimal: null,
				low: "low",
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			}),
			provider: "zai",
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "zai",
			},
		} as Model<Api>;

		await expect(titleFor(model)).resolves.toBe("Fix Login Bug");

		expect(endpoint.requests).toHaveLength(1);
		expect(endpoint.requests[0]?.zaiThinking).toBe("enabled");
		expect(endpoint.requests[0]?.zaiReasoningEffort).toBe("low");
		expect(endpoint.requests[0]?.maxTokens).toBeGreaterThan(64);
	});

	it("keeps the cheap reasoning-free title request for models that can disable reasoning", async () => {
		endpoint = await startMockEndpoint({ mandatoryReasoning: false });
		const model = openRouterModel("z-ai/glm-5.2", endpoint.baseUrl, { off: "none", high: "high", xhigh: "xhigh" });

		await expect(titleFor(model)).resolves.toBe("Fix Login Bug");

		expect(endpoint.requests).toHaveLength(1);
		expect(endpoint.requests[0]?.reasoningEffort).toBe("none");
		expect(endpoint.requests[0]?.maxTokens).toBe(64);
	});

	it("does not retry unrelated provider errors with reasoning", async () => {
		endpoint = await startMockEndpoint({
			mandatoryReasoning: false,
			failure: { status: 400, message: "Invalid request: context too long" },
		});
		const model = openRouterModel("meta/muse-spark-1.3-contributor", endpoint.baseUrl);

		await expect(titleFor(model)).rejects.toThrow("context too long");

		expect(endpoint.requests).toHaveLength(1);
	});
});
