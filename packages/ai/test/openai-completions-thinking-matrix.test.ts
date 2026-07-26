import { describe, expect, it } from "vitest";
import { stream, streamSimple } from "../src/api/openai-completions.ts";
import { getModels } from "../src/compat.ts";
import type { BuiltinProvider } from "../src/providers/all.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

type CapturedPayload = {
	reasoning?: { effort?: string };
	reasoning_effort?: string;
	thinking?: { type?: string } | string;
};

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

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
	reasoningEffort: "high",
): Promise<CapturedPayload> {
	let capturedPayload: CapturedPayload | undefined;
	const payloadCaptureModel: Model<"openai-completions"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const result = stream(payloadCaptureModel, context, {
		apiKey: "fake-key",
		reasoningEffort,
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
	it.each([
		{
			name: "DeepSeek's two-tier ladder on Alibaba Token Plan",
			model: getOpenAICompletionsModel("alibaba-token-plan", "deepseek-v3.2"),
			reasoning: "minimal" as const,
			expected: { thinking: { type: "enabled" }, reasoning_effort: "high" },
		},
		{
			name: "DeepSeek's max tier on Alibaba Token Plan",
			model: getOpenAICompletionsModel("alibaba-token-plan", "deepseek-v3.2"),
			reasoning: "xhigh" as const,
			expected: { thinking: { type: "enabled" }, reasoning_effort: "max" },
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

	it("uses Ollama's none off sentinel and max wire tier when no catalog map is present", async () => {
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
		expect(await capturePayload(model, "max")).toMatchObject({ reasoning_effort: "max" });
	});

	it("does not send OpenRouter's none sentinel for mandatory Kimi K3 thinking", async () => {
		const model = getOpenAICompletionsModel("openrouter", "moonshotai/kimi-k3");

		const payload = await capturePayload(model);

		expect(payload.reasoning).toBeUndefined();
	});
});
