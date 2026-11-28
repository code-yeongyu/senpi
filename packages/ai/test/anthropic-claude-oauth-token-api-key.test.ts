import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic, streamSimple as streamSimpleAnthropic } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#7391: an sk-ant-oat value given as an API key is an ordinary key. It goes out as
// `x-api-key` to the configured baseUrl, with none of the Claude Code identity removed by senpi#5131.

// Built from parts so no credential-shaped literal sits in the source for secret scanners (senpi#5308).
const OAUTH_TOKEN = ["sk-ant-oat01", "not-a-real-token"].join("-");
const PROXY_BASE_URL = "http://127.0.0.1:9/anthropic-proxy";

interface CapturedRequest {
	readonly url: string;
	readonly headers: Headers;
	readonly body: string;
}

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	tools: [
		{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
		{ name: "ask_user_question", description: "Ask", parameters: { type: "object", properties: {} } },
	],
});

const proxyModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic-proxy",
	baseUrl: PROXY_BASE_URL,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

function sseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } } })}\n`,
		`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function captureFetch(): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				url: input instanceof Request ? input.url : String(input),
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? init.body : "",
			});
			return sseResponse();
		}),
	);
	return requests;
}

function expectPlainApiKeyRequest(message: AssistantMessage, requests: readonly CapturedRequest[]): void {
	expect(message.stopReason).toBe("stop");
	expect(requests).toHaveLength(1);
	const [request] = requests;
	expect(request?.url.startsWith(`${PROXY_BASE_URL}/v1/messages`)).toBe(true);
	expect(request?.headers.get("x-api-key")).toBe(OAUTH_TOKEN);
	expect(request?.headers.get("authorization")).toBeNull();
	expect(request?.headers.get("x-app")).toBeNull();
	expect(request?.headers.get("user-agent") ?? "").not.toContain("claude-cli");
	expect(request?.headers.get("anthropic-beta") ?? "").not.toContain("claude-code-20250219");
	expect(request?.headers.get("anthropic-beta") ?? "").not.toContain("oauth-2025-04-20");
	expect(request?.body).not.toContain("You are Claude Code");
	const body = JSON.parse(request?.body ?? "{}") as { tools?: Array<{ name: string }> };
	expect(body.tools?.map((tool) => tool.name)).toEqual(["read", "ask_user_question"]);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("sk-ant-oat API keys on anthropic-messages (senpi#7391)", () => {
	it("stream sends the token as a plain x-api-key to the configured baseUrl", async () => {
		const requests = captureFetch();
		const message = await streamAnthropic(proxyModel, context, { apiKey: OAUTH_TOKEN, maxRetries: 0 }).result();
		expectPlainApiKeyRequest(message, requests);
	});

	it("streamSimple sends the token the same way", async () => {
		const requests = captureFetch();
		const message = await streamSimpleAnthropic(proxyModel, context, { apiKey: OAUTH_TOKEN }).result();
		expectPlainApiKeyRequest(message, requests);
	});
});
