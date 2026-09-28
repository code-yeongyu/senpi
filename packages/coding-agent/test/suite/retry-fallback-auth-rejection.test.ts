import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { isCredentialRejectionMessage } from "../../src/core/retry-fallback/auth-rejection.ts";
import { RetryFallbackController } from "../../src/core/retry-fallback/controller.ts";

function makeModel(provider: string, id: string): Model<Api> {
	return { provider, id } as unknown as Model<Api>;
}

const SUB_OPUS_55 = makeModel("anthropic-subscription", "claude-opus-5-5");
const SUB_OPUS_5 = makeModel("anthropic-subscription", "claude-opus-5");
const API_OPUS_5 = makeModel("anthropic", "claude-opus-5");
const API_OPUS_48 = makeModel("anthropic", "claude-opus-4-8");
const KIMI = makeModel("kimi-coding", "kimi-k3");
const MODELS = [SUB_OPUS_55, SUB_OPUS_5, API_OPUS_5, API_OPUS_48, KIMI];

const CHAIN = [
	"anthropic-subscription/claude-opus-5",
	"anthropic/claude-opus-5",
	"anthropic/claude-opus-4-8",
	"kimi-coding/kimi-k3",
];

function makeController(): { controller: RetryFallbackController; switched: string[] } {
	let current: { model: Model<Api>; thinkingLevel?: ThinkingLevel } = { model: SUB_OPUS_55 };
	const switched: string[] = [];
	const deps = {
		getSettings: () => ({ modelFallback: true, chains: { "anthropic-subscription/claude-opus-5-5": CHAIN } }),
		registry: {
			find: (provider: string, id: string) => MODELS.find((m) => m.provider === provider && m.id === id),
			getAll: () => MODELS,
			isUsingOAuth: () => false,
			isFallbackEligible: () => true,
		},
		cooldowns: { isSuppressed: () => false, note: () => {}, clear: () => {} },
		logger: { info: () => {}, debug: () => {} },
		switchModel: async (model: Model<Api>, thinkingLevel: ThinkingLevel) => {
			current = { model, thinkingLevel };
			switched.push(`${model.provider}/${model.id}`);
		},
		emit: () => {},
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
	};
	return { controller: new RetryFallbackController(deps as never), switched };
}

describe("retry fallback credential rejection", () => {
	it("#given a revoked subscription token and a rejected API key #when the chain falls back #then each dead provider's remaining rungs are skipped", async () => {
		const { controller, switched } = makeController();

		await controller.tryFallback("hard-error", {
			errorMessage: "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
		});
		await controller.tryFallback("hard-error", {
			errorMessage: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		});

		expect(switched).toEqual(["anthropic/claude-opus-5", "kimi-coding/kimi-k3"]);
	});

	it("#given a non-credential hard error #when the chain falls back #then the same provider's next rung stays eligible", async () => {
		const { controller, switched } = makeController();

		await controller.tryFallback("hard-error", { errorMessage: "invalid_request" });

		expect(switched).toEqual(["anthropic-subscription/claude-opus-5"]);
	});

	it("classifies credential rejections without matching unrelated errors", () => {
		expect(isCredentialRejectionMessage("401 OAuth access token has been revoked")).toBe(true);
		expect(isCredentialRejectionMessage("invalid x-api-key")).toBe(true);
		expect(
			isCredentialRejectionMessage(
				"All Claude accounts for anthropic-subscription are currently blocked (authentication error).",
			),
		).toBe(true);
		expect(isCredentialRejectionMessage("Provider stream start timed out after 90000ms")).toBe(false);
		expect(isCredentialRejectionMessage("billing error: insufficient_quota")).toBe(false);
		expect(isCredentialRejectionMessage(undefined)).toBe(false);
	});
});
