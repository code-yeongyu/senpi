import { describe, expect, it } from "vitest";
import { chatgptSubscriptionOAuth } from "../src/auth/oauth/chatgpt-subscription.ts";
import { getModel, getProviders } from "../src/compat.ts";
import { MODELS } from "../src/models.generated.ts";
import { builtinModels } from "../src/providers/all.ts";
import { CHATGPT_SUBSCRIPTION_MODELS } from "../src/providers/chatgpt-subscription.models.ts";
import type { KnownProvider } from "../src/types.ts";

/**
 * Provider rename: `openai-codex` -> `chatgpt-subscription` (display name
 * "OpenAI Codex" -> "ChatGPT Subscription"). The wire api id
 * `openai-codex-responses` is intentionally FROZEN - it names the wire
 * dialect (https://chatgpt.com/backend-api, codex/responses/compact), not
 * the provider.
 */

// Type-level: both ids are KnownProvider members ("openai-codex" retained as
// a documented legacy member). Proven by the repo typecheck gate.
const LEGACY_ID: KnownProvider = "openai-codex";
const CANONICAL_ID: KnownProvider = "chatgpt-subscription";
void CANONICAL_ID;

describe("chatgpt-subscription provider rename", () => {
	it("resolves gpt-5.6-sol under the chatgpt-subscription id with the frozen codex wire api", () => {
		const model = getModel("chatgpt-subscription", "gpt-5.6-sol");
		expect(model, "getModel('chatgpt-subscription', 'gpt-5.6-sol') must resolve").toBeDefined();
		expect(model?.api).toBe("openai-codex-responses");
		expect(model?.baseUrl).toBe("https://chatgpt.com/backend-api");
	});

	it("catalog rows carry the chatgpt-subscription provider id", () => {
		const models = Object.values(CHATGPT_SUBSCRIPTION_MODELS);
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.provider).toBe("chatgpt-subscription");
			expect(model.api).toBe("openai-codex-responses");
		}
	});

	it("builtin catalog keys use chatgpt-subscription, not openai-codex", () => {
		expect(Object.hasOwn(MODELS, "chatgpt-subscription")).toBe(true);
		expect(Object.hasOwn(MODELS, "openai-codex")).toBe(false);
		expect(getProviders()).toContain("chatgpt-subscription");
		expect(getProviders()).not.toContain("openai-codex");
	});

	it("builtin provider registry exposes the ChatGPT Subscription display name", () => {
		const provider = builtinModels().getProvider("chatgpt-subscription");
		expect(provider).toBeDefined();
		expect(provider?.id).toBe("chatgpt-subscription");
		expect(provider?.name).toBe("ChatGPT Subscription");
	});

	it("legacy openai-codex id no longer resolves in the builtin catalog", () => {
		// The legacy id is deliberately NOT a catalog key any more, so it no longer
		// type-checks as a provider argument. `getModel` is generic over the provider,
		// so casting the argument alone collapses the model id to `never`; cast the
		// function to a loose signature to keep the RUNTIME guarantee under test.
		const getModelLoose = getModel as unknown as (provider: string, model: string) => unknown;
		expect(getModelLoose(LEGACY_ID, "gpt-5.5")).toBeUndefined();
		expect(builtinModels().getProvider(LEGACY_ID)).toBeUndefined();
	});

	it("oauth flow carries the ChatGPT Subscription label", () => {
		expect(chatgptSubscriptionOAuth.name).toBe("ChatGPT Subscription (Plus/Pro)");
		expect(chatgptSubscriptionOAuth.isSubscription).toBe(true);
	});

	it("login select prompt says Select ChatGPT Subscription login method", async () => {
		let captured: unknown;
		await expect(
			chatgptSubscriptionOAuth.login({
				signal: new AbortController().signal,
				prompt: async (prompt) => {
					captured = prompt;
					// Bail out before any network or server is started.
					return "__test-stop__" as never;
				},
				notify: () => {},
			}),
		).rejects.toThrow("Unknown ChatGPT Subscription login method: __test-stop__");
		expect(captured).toMatchObject({
			type: "select",
			message: "Select ChatGPT Subscription login method:",
		});
	});
});
