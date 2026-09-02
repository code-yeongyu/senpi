import { describe, expect, it } from "vitest";
import { createProvider } from "../src/models.ts";
import { KIMI_CODE_RETRY_PROFILE, SENPI_DEFAULT_RETRY_PROFILE } from "../src/utils/retry-profile/profiles.ts";

describe("shipped retry profiles", () => {
	it("pins the shipped profiles", () => {
		expect(SENPI_DEFAULT_RETRY_PROFILE.id).toBe("senpi-default");
		expect(KIMI_CODE_RETRY_PROFILE.id).toBe("kimi-code");
		expect(SENPI_DEFAULT_RETRY_PROFILE.providerRequest.maxRetries).toBe(0);
		expect(SENPI_DEFAULT_RETRY_PROFILE.turn.maxRetries).toBe(5);
		expect(KIMI_CODE_RETRY_PROFILE.providerRequest.enabled).toBe(false);
		expect(KIMI_CODE_RETRY_PROFILE.turn.maxRetries).toBe(9);
	});

	it("forwards retryPolicy through provider creation", () => {
		const api = {
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		const input = {
			id: "test",
			auth: { apiKey: { name: "Test API key", resolve: async () => undefined } },
			models: [],
			api,
		};
		const without = createProvider(input);
		const withProfile = createProvider({ ...input, retryPolicy: KIMI_CODE_RETRY_PROFILE });
		expect(without.retryPolicy).toBeUndefined();
		expect(withProfile.retryPolicy).toBe(KIMI_CODE_RETRY_PROFILE);
	});
});

import { anthropicProvider } from "../src/providers/anthropic.ts";
import { kimiCodingProvider } from "../src/providers/kimi-coding.ts";
import { moonshotaiProvider } from "../src/providers/moonshotai.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openrouterProvider } from "../src/providers/openrouter.ts";

describe("provider retry profile declarations", () => {
	it("kimi-coding declares the kimi-code profile", () => {
		expect(kimiCodingProvider().retryPolicy?.id).toBe("kimi-code");
	});

	it("other built-in providers declare no profile", () => {
		expect(anthropicProvider().retryPolicy).toBeUndefined();
		expect(openaiProvider().retryPolicy).toBeUndefined();
		expect(moonshotaiProvider().retryPolicy).toBeUndefined();
		expect(openrouterProvider().retryPolicy).toBeUndefined();
	});
});

describe("phase-2: senpi-default turn cap", () => {
	it("senpi-default turn backoff caps at 8s", () => {
		expect(SENPI_DEFAULT_RETRY_PROFILE.turn.backoff.perAttemptCapMs).toBe(8_000);
	});
});
