import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ClaudeOAuthTokenRefusedError,
	isClaudeOAuthTokenRefusedError,
	stream as streamAnthropic,
	streamSimple as streamSimpleAnthropic,
} from "../src/api/anthropic-messages.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#5131: a Claude OAuth token (sk-ant-oat...) handed to the plain `anthropic` provider is
// refused before any network call. senpi no longer presents itself as Claude Code toward the
// Messages API; the sanctioned subscription path is `anthropic-subscription`.

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
	createParams: undefined as Record<string, unknown> | undefined,
	constructions: 0,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructions++;
			mockState.constructorOpts = opts;
		}
		beta = {
			messages: {
				create: (params: Record<string, unknown>) => {
					mockState.createParams = params;
					return { asResponse: async () => createSseResponse() };
				},
			},
		};
	}

	return { default: FakeAnthropic };
});

// Built from parts so no credential-shaped literal sits in the source for secret scanners (senpi#5308).
const OAUTH_TOKEN = ["sk-ant-oat01", "not-a-real-token"].join("-");
const API_KEY = ["sk-ant-api03", "not-a-real-key"].join("-");

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	tools: [
		{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
		{ name: "ask_user_question", description: "Ask", parameters: { type: "object", properties: {} } },
	],
});

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

afterEach(() => {
	mockState.constructorOpts = undefined;
	mockState.createParams = undefined;
	mockState.constructions = 0;
});

describe("Claude OAuth tokens on the anthropic provider (senpi#5131)", () => {
	it("refuses an sk-ant-oat apiKey before constructing a client or sending a request", async () => {
		const message = await streamAnthropic(anthropicModel, context, { apiKey: OAUTH_TOKEN }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("/login anthropic-subscription");
		expect(message.errorMessage).toContain("anthropic/claude-test");
		expect(message.errorMessage).not.toContain(OAUTH_TOKEN);
		expect(mockState.constructions).toBe(0);
		expect(mockState.createParams).toBeUndefined();
	});

	it("refuses the token that arrives through ANTHROPIC_OAUTH_TOKEN the same way", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "ANTHROPIC_OAUTH_TOKEN" ? OAUTH_TOKEN : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());

		const message = await models.streamSimple(anthropicModel, context).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("/login anthropic-subscription");
		expect(mockState.constructions).toBe(0);
	});

	it("throws the typed error synchronously from streamSimple, like a missing key", () => {
		let caught: unknown;
		try {
			streamSimpleAnthropic(anthropicModel, context, { apiKey: OAUTH_TOKEN });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ClaudeOAuthTokenRefusedError);
		expect(isClaudeOAuthTokenRefusedError(caught)).toBe(true);
		expect((caught as ClaudeOAuthTokenRefusedError).code).toBe("claude_oauth_token_refused");
		expect((caught as ClaudeOAuthTokenRefusedError).provider).toBe("anthropic");
		expect(isClaudeOAuthTokenRefusedError(new Error("No API key for provider: anthropic"))).toBe(false);
	});

	it("sends an API key request with no Claude Code identity and unmapped tool names", async () => {
		const message = await streamAnthropic(anthropicModel, context, { apiKey: API_KEY }).result();

		expect(message.stopReason).toBe("stop");
		expect(mockState.constructorOpts?.apiKey).toBe(API_KEY);
		expect(mockState.constructorOpts?.authToken).toBeNull();
		const headers = mockState.constructorOpts?.defaultHeaders as Record<string, string | null>;
		expect(headers["user-agent"]).toBeUndefined();
		expect(headers["x-app"]).toBeUndefined();
		expect(headers["anthropic-beta"] ?? "").not.toContain("claude-code-20250219");
		expect(headers["anthropic-beta"] ?? "").not.toContain("oauth-2025-04-20");
		expect(mockState.createParams?.betas ?? []).not.toContain("claude-code-20250219");
		expect(mockState.createParams?.betas ?? []).not.toContain("oauth-2025-04-20");
		expect(mockState.createParams?.system).toEqual([expect.objectContaining({ text: "System prompt." })]);
		expect(JSON.stringify(mockState.createParams)).not.toContain("You are Claude Code");
		const tools = mockState.createParams?.tools as Array<{ name: string }>;
		expect(tools.map((tool) => tool.name)).toEqual(["read", "ask_user_question"]);
	});
});
