import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { builtinModels } from "../src/providers/all.ts";

const originalVeniceApiKey = process.env.VENICE_API_KEY;

afterEach(() => {
	if (originalVeniceApiKey === undefined) {
		delete process.env.VENICE_API_KEY;
	} else {
		process.env.VENICE_API_KEY = originalVeniceApiKey;
	}
});

// Wire evidence: `components.schemas.ChatCompletionRequest` in
// https://api.venice.ai/api/v1/swagger.yaml is `additionalProperties: false`,
// so a top-level field outside this set is a 400 rather than an ignored key.
const VENICE_ACCEPTED_REQUEST_FIELDS = new Set([
	"fallbacks",
	"frequency_penalty",
	"include",
	"logprobs",
	"max_completion_tokens",
	"max_temp",
	"max_tokens",
	"messages",
	"metadata",
	"min_p",
	"min_temp",
	"model",
	"n",
	"parallel_tool_calls",
	"presence_penalty",
	"prompt_cache_key",
	"prompt_cache_retention",
	"reasoning",
	"reasoning_effort",
	"repetition_penalty",
	"response_format",
	"seed",
	"stop",
	"stop_token_ids",
	"store",
	"stream",
	"stream_options",
	"temperature",
	"text",
	"tool_choice",
	"tools",
	"top_k",
	"top_logprobs",
	"top_p",
	"user",
	"venice_parameters",
	"verbosity",
]);

async function capturePayload(
	options: { reasoning?: "high"; maxTokens?: number } = {},
): Promise<Record<string, unknown>> {
	const model = getModel("venice", "zai-org-glm-5-2");
	let payload: Record<string, unknown> | undefined;

	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
		{
			apiKey: "test-venice-key",
			...options,
			onPayload: (value) => {
				payload = value as Record<string, unknown>;
				throw new Error("payload captured");
			},
		},
	).result();

	expect(payload).toBeDefined();
	return payload as Record<string, unknown>;
}

describe("Venice models", () => {
	it("registers Venice as a built-in OpenAI-compatible provider", () => {
		const models = builtinModels();
		const provider = models.getProviders().find((entry) => entry.id === "venice");

		expect(provider).toBeDefined();
		expect(provider?.name).toBe("Venice AI");
		expect(provider?.baseUrl).toBe("https://api.venice.ai/api/v1");

		const catalog = models.getModels("venice");
		expect(catalog.length).toBeGreaterThan(0);
		expect(catalog.every((model) => model.provider === "venice")).toBe(true);
		expect(catalog.every((model) => model.api === "openai-completions")).toBe(true);
		expect(catalog.every((model) => model.baseUrl === "https://api.venice.ai/api/v1")).toBe(true);
	});

	it("maps GLM 5.2 reasoning onto Venice's reasoning_effort ladder", () => {
		const model = getModel("venice", "zai-org-glm-5-2");

		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "venice",
			baseUrl: "https://api.venice.ai/api/v1",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 131072,
		});
		expect(model.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high", "max"]);
	});

	it("suppresses Venice's default system prompt on every catalog model", () => {
		const catalog = builtinModels().getModels("venice");

		expect(catalog.length).toBeGreaterThan(0);
		for (const model of catalog) {
			expect(model.compat).toMatchObject({ veniceParameters: { include_venice_system_prompt: false } });
		}
	});

	it("sends venice_parameters so Venice does not prepend its own system prompt", async () => {
		const payload = await capturePayload();

		expect(payload.venice_parameters).toEqual({ include_venice_system_prompt: false });
	});

	it("sends only request fields Venice's additionalProperties:false schema accepts", async () => {
		for (const options of [{}, { reasoning: "high" as const, maxTokens: 1024 }]) {
			const payload = await capturePayload(options);
			const sent = Object.keys(payload).filter((key) => payload[key] !== undefined);

			expect(sent.length).toBeGreaterThan(0);
			expect(sent.filter((key) => !VENICE_ACCEPTED_REQUEST_FIELDS.has(key))).toEqual([]);
		}
	});

	it("drives thinking through reasoning_effort", async () => {
		expect((await capturePayload({ reasoning: "high" })).reasoning_effort).toBe("high");
		expect((await capturePayload()).reasoning_effort).toBe("none");
	});

	it("caps output with max_completion_tokens, not the deprecated max_tokens", async () => {
		const payload = await capturePayload({ maxTokens: 1024 });

		expect(payload.max_completion_tokens).toBe(1024);
		expect(payload.max_tokens).toBeUndefined();
	});

	it("resolves VENICE_API_KEY from the environment", () => {
		process.env.VENICE_API_KEY = "test-venice-key";

		expect(findEnvKeys("venice")).toEqual(["VENICE_API_KEY"]);
		expect(getEnvApiKey("venice")).toBe("test-venice-key");
	});
});
