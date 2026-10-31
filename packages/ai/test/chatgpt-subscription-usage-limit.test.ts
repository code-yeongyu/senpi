import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#3615: a ChatGPT sign-in past its plan limit must say which limit applies and what to do next.

afterEach(() => {
	vi.unstubAllGlobals();
});

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OTHER_ROUTES =
	"To keep going now, add an OpenAI API key, sign in with another ChatGPT account, or switch providers.";

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function makeModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "chatgpt-subscription",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

async function errorMessageFor(response: () => Response): Promise<string | undefined> {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL) => {
			if (String(input) !== ENDPOINT) throw new Error(`Unexpected URL: ${String(input)}`);
			return response();
		}),
	);
	const context = normalizeContext({
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	});
	const result = await streamOpenAICodexResponses(makeModel(), context, {
		apiKey: mockToken(),
		transport: "sse",
		maxRetries: 0,
	}).result();
	expect(result.stopReason).toBe("error");
	return result.errorMessage;
}

function usageLimitBody(planType: string, resetsAt?: number): string {
	return JSON.stringify({
		error: {
			type: "usage_limit_reached",
			message: "The usage limit has been reached",
			plan_type: planType,
			...(resetsAt === undefined ? {} : { resets_at: resetsAt }),
		},
	});
}

function http429(body: string, headers: Record<string, string> = {}): () => Response {
	return () => new Response(body, { status: 429, headers: { "content-type": "application/json", ...headers } });
}

describe("ChatGPT usage-limit refusal wording (#3615)", () => {
	it("says an account with credits did not get them applied, and names every way to keep going", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3600;
		const message = await errorMessageFor(
			http429(usageLimitBody("pro", resetsAt), {
				"x-codex-credits-has-credits": "True",
				"x-codex-credits-unlimited": "false",
				"x-codex-credits-balance": "12.5",
			}),
		);
		expect(message).toBe(
			`You have hit your ChatGPT usage limit (pro plan). This account has ChatGPT credits, but ChatGPT did not apply them to this request. ${OTHER_ROUTES} Try again in ~60 min.`,
		);
	});

	it.each([
		[
			"workspace_owner_credits_depleted",
			"Your workspace is out of credits: add credits at https://chatgpt.com/settings/usage.",
		],
		["workspace_member_credits_depleted", "Your workspace is out of credits: ask your workspace owner to add more."],
		["workspace_owner_usage_limit_reached", "You hit the spend cap set for your workspace: raise it to continue."],
		[
			"workspace_member_usage_limit_reached",
			"You hit the spend cap your workspace owner set: ask an owner to raise it to continue.",
		],
	])("maps x-codex-rate-limit-reached-type %s ahead of the credits header", async (reachedType, advice) => {
		const message = await errorMessageFor(
			http429(usageLimitBody("business"), {
				"x-codex-rate-limit-reached-type": reachedType,
				"x-codex-credits-has-credits": "true",
			}),
		);
		expect(message).toBe(`You have hit your ChatGPT usage limit (business plan). ${advice} ${OTHER_ROUTES}`);
	});

	it("falls back to the plan's own advice when the account has no credits", async () => {
		const message = await errorMessageFor(
			http429(usageLimitBody("plus"), { "x-codex-credits-has-credits": "false" }),
		);
		expect(message).toBe(
			`You have hit your ChatGPT usage limit (plus plan). Upgrade to Pro, or buy credits at https://chatgpt.com/settings/usage. ${OTHER_ROUTES}`,
		);
	});

	it("leaves the backend's free-form promo out, so a model name in it cannot narrow the limit to one model", async () => {
		const message = await errorMessageFor(
			http429(usageLimitBody("plus"), { "x-codex-promo-message": "Try a smaller model for more usage" }),
		);
		expect(message).toBe(
			`You have hit your ChatGPT usage limit (plus plan). Upgrade to Pro, or buy credits at https://chatgpt.com/settings/usage. ${OTHER_ROUTES}`,
		);
	});

	it("reads the status and headers a WebSocket-style error event carries inline", async () => {
		const event = {
			type: "error",
			status: 429,
			error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "pro" },
			headers: { "X-Codex-Credits-Has-Credits": "true" },
		};
		const message = await errorMessageFor(
			() =>
				new Response(`data: ${JSON.stringify(event)}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		expect(message).toBe(
			`You have hit your ChatGPT usage limit (pro plan). This account has ChatGPT credits, but ChatGPT did not apply them to this request. ${OTHER_ROUTES}`,
		);
	});

	it("leaves an in-stream rate limit that is not a usage limit untouched", async () => {
		const event = { type: "error", error: { type: "rate_limit_error", message: "All tokens rate limited" } };
		const message = await errorMessageFor(
			() =>
				new Response(`data: ${JSON.stringify(event)}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		expect(message).toBe("Codex error: All tokens rate limited");
	});
});
