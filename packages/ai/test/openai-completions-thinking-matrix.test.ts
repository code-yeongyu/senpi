import { describe, expect, it } from "vitest";
import { stream, streamSimple } from "../src/api/openai-completions.ts";
import { getModels } from "../src/compat.ts";
import type { BuiltinProvider } from "../src/providers/all.ts";
import type { Context, Model, ModelThinkingLevel, SimpleStreamOptions } from "../src/types.ts";

type CapturedPayload = {
	enable_thinking?: boolean;
	reasoning?: { effort?: string };
	reasoning_effort?: string;
	thinking?: { type?: string } | string;
};

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

const DIRECT_QWEN38_MODEL_CASES = [
	{ provider: "alibaba-token-plan", id: "qwen3.8-flash" },
	{ provider: "alibaba-token-plan", id: "qwen3.8-max" },
	{ provider: "alibaba-token-plan", id: "qwen3.8-max-preview" },
	{ provider: "qwen-token-plan", id: "qwen3.8-flash" },
	{ provider: "qwen-token-plan", id: "qwen3.8-max" },
	{ provider: "qwen-token-plan-cn", id: "qwen3.8-flash" },
	{ provider: "qwen-token-plan-cn", id: "qwen3.8-max" },
	{ provider: "qwen-token-plan-individual", id: "qwen3.8-max" },
] as const;

const QWEN38_SELECTOR_CASES = [
	{ reasoning: "off", expected: { enable_thinking: false } },
	{ reasoning: "minimal", expected: { enable_thinking: true, reasoning_effort: "low" } },
	{ reasoning: "low", expected: { enable_thinking: true, reasoning_effort: "low" } },
	{ reasoning: "medium", expected: { enable_thinking: true, reasoning_effort: "medium" } },
	{ reasoning: "high", expected: { enable_thinking: true, reasoning_effort: "xhigh" } },
	{ reasoning: "xhigh", expected: { enable_thinking: true, reasoning_effort: "xhigh" } },
	{ reasoning: "max", expected: { enable_thinking: true, reasoning_effort: "xhigh" } },
] as const;

async function capturePayload(
	model: Model<"openai-completions">,
	reasoning?: SimpleStreamOptions["reasoning"],
): Promise<CapturedPayload> {
	let capturedPayload: CapturedPayload | undefined;
	const payloadCaptureModel: Model<"openai-completions"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const result = streamSimple(payloadCaptureModel, context, {
		apiKey: "fake-key",
		...(reasoning === undefined ? {} : { reasoning }),
		onPayload: (payload) => {
			capturedPayload = payload as CapturedPayload;
			return payload;
		},
	});

	await result.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

async function captureDirectPayload(
	model: Model<"openai-completions">,
	reasoningEffort: ModelThinkingLevel,
): Promise<CapturedPayload> {
	let capturedPayload: CapturedPayload | undefined;
	const payloadCaptureModel: Model<"openai-completions"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const result = stream(payloadCaptureModel, context, {
		apiKey: "fake-key",
		reasoningEffort: reasoningEffort as Exclude<ModelThinkingLevel, "off">,
		onPayload: (payload) => {
			capturedPayload = payload as CapturedPayload;
			return payload;
		},
	});

	await result.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

function getOpenAICompletionsModel(provider: BuiltinProvider, id: string): Model<"openai-completions"> {
	const model = (getModels(provider) as Model<"openai-completions">[]).find((candidate) => candidate.id === id);
	if (model?.api !== "openai-completions") {
		throw new Error(`Expected OpenAI Completions model ${provider}/${id}`);
	}
	return model;
}

describe("OpenAI Completions thinking ladder fallbacks", () => {
	it("infers the GPT-6 Astra ladder for map-less custom models", async () => {
		const model = {
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			api: "openai-completions",
			provider: "quotio-openai",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1050000,
			maxTokens: 128000,
		} satisfies Model<"openai-completions">;

		expect(await capturePayload(model, "minimal")).toMatchObject({ reasoning_effort: "low" });
		expect(await capturePayload(model)).toMatchObject({ reasoning_effort: "low" });
		expect(await captureDirectPayload(model, "xhigh")).toMatchObject({ reasoning_effort: "xhigh" });
		expect(await captureDirectPayload(model, "max")).toMatchObject({ reasoning_effort: "max" });
	});

	it.each([
		{
			name: "DeepSeek's enable switch on Alibaba Token Plan",
			model: getOpenAICompletionsModel("alibaba-token-plan", "deepseek-v3.2"),
			reasoning: "minimal" as const,
			expected: { thinking: { type: "enabled" } },
		},
		{
			name: "DeepSeek's enable switch on Alibaba Token Plan",
			model: getOpenAICompletionsModel("alibaba-token-plan", "deepseek-v3.2"),
			reasoning: "high" as const,
			expected: { thinking: { type: "enabled" } },
		},
		{
			name: "OpenRouter DeepSeek's high-only ladder",
			model: getOpenAICompletionsModel("openrouter", "deepseek/deepseek-r1"),
			reasoning: "minimal" as const,
			expected: { reasoning: { effort: "high" } },
		},
		{
			name: "OpenRouter MiMo's minimal-to-low mapping",
			model: getOpenAICompletionsModel("openrouter", "xiaomi/mimo-v2.5"),
			reasoning: "minimal" as const,
			expected: { reasoning: { effort: "low" } },
		},
		{
			name: "OpenRouter Kimi K3's minimal-to-low mapping",
			model: getOpenAICompletionsModel("openrouter", "moonshotai/kimi-k3"),
			reasoning: "minimal" as const,
			expected: { reasoning: { effort: "low" } },
		},
		{
			name: "the default GLM-5.2 max tier",
			model: getOpenAICompletionsModel("alibaba-token-plan", "glm-5.2"),
			reasoning: "max" as const,
			expected: { reasoning_effort: "max" },
		},
	])("uses $name", async ({ model, reasoning, expected }) => {
		const payload = await capturePayload(model, reasoning);

		expect(payload).toMatchObject(expected);
	});

	it.each([
		{
			format: "zai" as const,
			expected: { thinking: { type: "enabled" } },
			absent: ["reasoning_effort"],
		},
		{
			format: "deepseek" as const,
			expected: { thinking: { type: "enabled" } },
			absent: ["reasoning_effort"],
		},
		{
			format: "openrouter" as const,
			expected: {},
			absent: ["reasoning"],
		},
		{
			format: "together" as const,
			expected: { reasoning: { enabled: true } },
			absent: ["reasoning_effort"],
		},
		{
			format: "string-thinking" as const,
			expected: {},
			absent: ["thinking"],
		},
		{
			format: "openai" as const,
			expected: {},
			absent: ["reasoning_effort"],
		},
	])("does not send a null-mapped effort for $format", async ({ format, expected, absent }) => {
		const model = {
			id: `explicit-null-${format}`,
			name: "Explicit null map",
			api: "openai-completions",
			provider: "local",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			thinkingLevelMap: { high: null },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 8192,
			compat: { thinkingFormat: format, supportsReasoningEffort: true },
		} satisfies Model<"openai-completions">;

		const payload = await captureDirectPayload(model, "high");
		expect(payload).toMatchObject(expected);
		for (const field of absent) {
			expect(payload).not.toHaveProperty(field);
		}
	});

	it.each([
		{
			name: "Alibaba DeepSeek",
			model: getOpenAICompletionsModel("alibaba-token-plan", "deepseek-v3.2"),
			on: { thinking: { type: "enabled" } },
			off: { thinking: { type: "disabled" } },
		},
		{
			name: "Qwen Token Plan",
			model: getOpenAICompletionsModel("qwen-token-plan", "qwen3.7-max"),
			on: { enable_thinking: true },
			off: { enable_thinking: false },
		},
		{
			name: "Moonshot Kimi",
			model: getOpenAICompletionsModel("moonshotai", "kimi-k2.6"),
			on: { thinking: { type: "enabled" } },
			off: { thinking: { type: "disabled" } },
		},
		{
			name: "Xiaomi MiMo",
			model: getOpenAICompletionsModel("xiaomi", "mimo-v2.5-pro"),
			on: { thinking: { type: "enabled" } },
			off: { thinking: { type: "disabled" } },
		},
		{
			name: "Z.AI GLM",
			model: getOpenAICompletionsModel("zai", "glm-5-turbo"),
			on: { thinking: { type: "enabled" } },
			off: { thinking: { type: "disabled" } },
		},
	])("serializes every on/off effort request identically for $name", async ({ model, on, off }) => {
		const enabledPayloads = await Promise.all(
			(["minimal", "low", "medium", "high"] as const).map((level) => captureDirectPayload(model, level)),
		);

		for (const payload of enabledPayloads) {
			expect(payload).toMatchObject(on);
			expect(payload.reasoning_effort).toBeUndefined();
		}
		expect(await capturePayload(model)).toMatchObject(off);
	});

	it.each(DIRECT_QWEN38_MODEL_CASES)(
		"serializes Qwen3.8's documented selector ladder for $provider/$id",
		async ({ provider, id }) => {
			const model = getOpenAICompletionsModel(provider, id);

			for (const { reasoning, expected } of QWEN38_SELECTOR_CASES) {
				const payload = await capturePayload(model, reasoning === "off" ? undefined : reasoning);

				expect(payload).toMatchObject(expected);
				expect(payload).not.toHaveProperty("thinking_budget");
				if (reasoning === "off") {
					expect(payload).not.toHaveProperty("reasoning_effort");
				}
			}
		},
	);

	it("preserves map-less GPT-5.6 Sol's existing effort behavior", async () => {
		const model = {
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-completions",
			provider: "quotio-openai",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 650000,
			maxTokens: 128000,
			compat: { thinkingFormat: "openai", supportsReasoningEffort: true },
		} satisfies Model<"openai-completions">;

		expect(await captureDirectPayload(model, "minimal")).toMatchObject({ reasoning_effort: "minimal" });
		expect(await captureDirectPayload(model, "off")).toMatchObject({ reasoning_effort: "off" });
	});

	it("uses Ollama's none off sentinel and clamps max to its highest supported wire tier", async () => {
		const model = {
			id: "qwen3",
			name: "Qwen3",
			api: "openai-completions",
			provider: "ollama",
			baseUrl: "http://localhost:11434/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 8192,
		} satisfies Model<"openai-completions">;

		expect(await capturePayload(model)).toMatchObject({ reasoning_effort: "none" });
		expect(await capturePayload(model, "max")).toMatchObject({ reasoning_effort: "high" });
	});

	it("does not send OpenRouter's none sentinel for mandatory Kimi K3 thinking", async () => {
		const model = getOpenAICompletionsModel("openrouter", "moonshotai/kimi-k3");

		const payload = await capturePayload(model);

		expect(payload.reasoning).toBeUndefined();
	});
});
