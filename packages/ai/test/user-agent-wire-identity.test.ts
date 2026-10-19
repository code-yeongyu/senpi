import { arch, platform, release } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { forcePiUserAgent, getPiUserAgent } from "../src/utils/pi-user-agent.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { resetWireIdentityForTests, setWireIdentity } from "../src/wire-identity.ts";

const RUNTIME = `(${platform()} ${release()}; ${arch()})`;

const model: Model<"openai-completions"> = {
	id: "echo-1",
	name: "Echo",
	api: "openai-completions",
	provider: "echo",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function completionsStream(): Response {
	const chunks = [
		{ id: "chatcmpl-ua", choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }] },
		{
			id: "chatcmpl-ua",
			choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
			usage: {
				prompt_tokens: 1,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 0 },
				completion_tokens_details: { reasoning_tokens: 0 },
			},
		},
	];
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function captureUserAgent(requestModel: Model<"openai-completions"> = model): Promise<string | null> {
	let userAgent: string | null = null;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		userAgent = new Request(input, init).headers.get("user-agent");
		return completionsStream();
	});
	const result = await streamOpenAICompletions(
		requestModel,
		normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
		{ apiKey: "test-key" },
	).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	return userAgent;
}

describe("provider User-Agent wire identity", () => {
	afterEach(() => {
		resetWireIdentityForTests();
		vi.restoreAllMocks();
	});

	it("defaults to the engine identity", () => {
		expect(getPiUserAgent()).toBe(`senpi ${RUNTIME}`);
	});

	it("names a branded distribution on an OpenAI-completions request", async () => {
		setWireIdentity("omo");

		expect(await captureUserAgent()).toBe(`omo ${RUNTIME}`);
	});

	it("lets an explicit model header keep its own User-Agent", async () => {
		setWireIdentity("omo");

		const explicit = await captureUserAgent({
			...model,
			headers: { "User-Agent": "custom-client/1.0" },
		} as Model<"openai-completions">);

		expect(explicit).toBe("custom-client/1.0");
	});

	it("forces the running product identity over a case-variant header", () => {
		setWireIdentity("omo");
		const headers: Record<string, string> = { "user-agent": "stale/1.0" };

		forcePiUserAgent(headers);

		expect(headers).toEqual({ "User-Agent": `omo ${RUNTIME}` });
	});
});
