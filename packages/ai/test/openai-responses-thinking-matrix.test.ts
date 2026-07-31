import { describe, expect, it } from "vitest";
import {
	stream as streamAzureOpenAIResponses,
	streamSimple as streamSimpleAzureOpenAIResponses,
} from "../src/api/azure-openai-responses.ts";
import {
	stream as streamOpenAICodexResponses,
	streamSimple as streamSimpleOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamSimpleOpenAICompletions } from "../src/api/openai-completions.ts";
import {
	stream as streamOpenAIResponses,
	streamSimple as streamSimpleOpenAIResponses,
} from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import { supportsXhigh } from "../src/models.ts";

interface ReasoningPayload {
	reasoning?: { effort?: string; summary?: string };
	reasoning_effort?: string;
}

const context = {
	messages: [{ role: "user" as const, content: "Hello", timestamp: 0 }],
};

async function capturePayload(
	createStream: (onPayload: (payload: unknown) => never) => { result(): Promise<unknown> },
): Promise<ReasoningPayload> {
	let capturedPayload: ReasoningPayload | undefined;

	await createStream((payload) => {
		capturedPayload = payload as ReasoningPayload;
		throw new Error("payload captured");
	}).result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("OpenAI Responses thinking matrix", () => {
	it("preserves OpenAI's explicit gpt-5.6 max effort mapping", async () => {
		const payload = await capturePayload((onPayload) =>
			streamSimpleOpenAIResponses(getModel("openai", "gpt-5.6-sol"), context, {
				apiKey: "test-key",
				reasoning: "max",
				onPayload,
			}),
		);

		expect(payload).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });
	});

	it("preserves max effort for a map-less gpt-5.6-sol model", async () => {
		const model = {
			...getModel("openai", "gpt-5.6-sol"),
			provider: "codex-lb",
			thinkingLevelMap: undefined,
		};
		const payload = await capturePayload((onPayload) =>
			streamSimpleOpenAIResponses(model, context, {
				apiKey: "test-key",
				reasoning: "max",
				onPayload,
			}),
		);

		expect(payload).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });
	});

	it("preserves max effort for a map-less gpt-5.6-sol model on Azure Responses", async () => {
		const model = {
			...getModel("azure-openai-responses", "gpt-5.6-sol"),
			baseUrl: "http://127.0.0.1:9",
			thinkingLevelMap: undefined,
		};
		const payload = await capturePayload((onPayload) =>
			streamSimpleAzureOpenAIResponses(model, context, { apiKey: "test-key", reasoning: "max", onPayload }),
		);

		expect(payload).toMatchObject({ reasoning: { effort: "max" } });
	});

	it("preserves max effort for a map-less gpt-5.6-sol model on Codex Responses", async () => {
		const model = {
			...getModel("openai-codex", "gpt-5.6-sol"),
			thinkingLevelMap: undefined,
		};
		const payload = await capturePayload((onPayload) =>
			streamSimpleOpenAICodexResponses(model, context, {
				apiKey: "test-key",
				transport: "sse",
				reasoning: "max",
				onPayload,
			}),
		);

		expect(payload).toMatchObject({ reasoning: { effort: "max" } });
	});

	it("preserves max effort for a map-less gpt-5.6-sol model on Completions", async () => {
		const model = {
			...getModel("openai", "gpt-5.6-sol"),
			api: "openai-completions" as const,
			baseUrl: "http://127.0.0.1:9",
			thinkingLevelMap: undefined,
		};
		const payload = await capturePayload((onPayload) =>
			streamSimpleOpenAICompletions(model, context, { apiKey: "test-key", reasoning: "max", onPayload }),
		);

		expect(payload.reasoning_effort).toBe("max");
	});

	it("preserves Azure's explicit gpt-5.6 max effort mapping", async () => {
		const model = {
			...getModel("azure-openai-responses", "gpt-5.6-sol"),
			baseUrl: "http://127.0.0.1:9",
		};
		const payload = await capturePayload((onPayload) =>
			streamSimpleAzureOpenAIResponses(model, context, {
				apiKey: "test-key",
				reasoning: "max",
				onPayload,
			}),
		);

		expect(payload).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });
	});

	it("sends Codex's none sentinel when the agent represents thinking off as omitted reasoning", async () => {
		const payload = await capturePayload((onPayload) =>
			streamSimpleOpenAICodexResponses(getModel("openai-codex", "gpt-5.6-sol"), context, {
				apiKey: "test-key",
				transport: "sse",
				onPayload,
			}),
		);

		expect(payload).toMatchObject({ reasoning: { effort: "none", summary: "auto" } });
	});

	it.each([
		["null", null, undefined],
		["off", "off", undefined],
		["on", "on", "auto"],
		["auto", "auto", "auto"],
	] as const)(
		"normalizes Codex %s summary on the explicit-effort path",
		async (_, reasoningSummary, expectedSummary) => {
			const payload = await capturePayload((onPayload) =>
				streamOpenAICodexResponses(getModel("openai-codex", "gpt-5.6-sol"), context, {
					apiKey: "test-key",
					transport: "sse",
					reasoningEffort: "low",
					reasoningSummary,
					onPayload,
				}),
			);

			expect(payload.reasoning).toEqual({
				effort: "low",
				...(expectedSummary ? { summary: expectedSummary } : {}),
			});
		},
	);

	it.each([
		["null", null, undefined],
		["off", "off", undefined],
		["on", "on", "auto"],
		["auto", "auto", "auto"],
	] as const)(
		"normalizes Codex %s summary on the thinking-off fallback",
		async (_, reasoningSummary, expectedSummary) => {
			const payload = await capturePayload((onPayload) =>
				streamOpenAICodexResponses(getModel("openai-codex", "gpt-5.6-sol"), context, {
					apiKey: "test-key",
					transport: "sse",
					reasoningSummary,
					onPayload,
				}),
			);

			expect(payload.reasoning).toEqual({
				effort: "none",
				...(expectedSummary ? { summary: expectedSummary } : {}),
			});
		},
	);

	it("omits Codex reasoning when the catalog says thinking cannot be disabled", async () => {
		const model = {
			...getModel("openai-codex", "gpt-5.6-sol"),
			thinkingLevelMap: { off: null },
		};
		const payload = await capturePayload((onPayload) =>
			streamSimpleOpenAICodexResponses(model, context, {
				apiKey: "test-key",
				transport: "sse",
				onPayload,
			}),
		);

		expect(payload).not.toHaveProperty("reasoning");
	});

	it("omits Azure reasoning when the catalog says thinking cannot be disabled", async () => {
		const model = {
			...getModel("azure-openai-responses", "gpt-5.6-sol"),
			baseUrl: "http://127.0.0.1:9",
		};
		const payload = await capturePayload((onPayload) =>
			streamSimpleAzureOpenAIResponses(model, context, {
				apiKey: "test-key",
				onPayload,
			}),
		);

		expect(payload).not.toHaveProperty("reasoning");
	});

	it("omits xAI reasoning when the catalog says thinking cannot be disabled", async () => {
		const payload = await capturePayload((onPayload) =>
			streamSimpleOpenAIResponses(getModel("xai", "grok-4.5"), context, {
				apiKey: "test-key",
				onPayload,
			}),
		);

		expect(payload).not.toHaveProperty("reasoning");
	});

	it("does not send an unavailable explicit OpenAI effort", async () => {
		const payload = await capturePayload((onPayload) =>
			streamOpenAIResponses(getModel("openai", "gpt-5.1"), context, {
				apiKey: "test-key",
				reasoningEffort: "minimal",
				onPayload,
			}),
		);

		expect(payload).not.toHaveProperty("reasoning");
	});

	it("does not send an unavailable summary-default OpenAI effort", async () => {
		const payload = await capturePayload((onPayload) =>
			streamOpenAIResponses(getModel("openai", "gpt-5-pro"), context, {
				apiKey: "test-key",
				reasoningSummary: "auto",
				onPayload,
			}),
		);

		expect(payload).not.toHaveProperty("reasoning");
	});

	it("does not send an unavailable explicit Azure effort", async () => {
		const model = {
			...getModel("azure-openai-responses", "gpt-5.5-pro"),
			baseUrl: "http://127.0.0.1:9",
		};
		const payload = await capturePayload((onPayload) =>
			streamAzureOpenAIResponses(model, context, {
				apiKey: "test-key",
				reasoningEffort: "minimal",
				onPayload,
			}),
		);

		expect(payload).not.toHaveProperty("reasoning");
	});

	it("does not send Codex's none sentinel when the catalog forbids thinking off", async () => {
		const model = {
			...getModel("openai-codex", "gpt-5.6-sol"),
			thinkingLevelMap: { off: null },
		};
		const payload = await capturePayload((onPayload) =>
			streamOpenAICodexResponses(model, context, {
				apiKey: "test-key",
				transport: "sse",
				reasoningEffort: "none",
				onPayload,
			}),
		);

		expect(payload).not.toHaveProperty("reasoning");
	});

	it.each(["gpt-5.2", "gpt-5.3-codex", "gpt-5.4", "gpt-5.5", "gpt-5.6-sol"] as const)(
		"recognizes OpenAI %s as xhigh-capable",
		(modelId) => {
			expect(supportsXhigh(getModel("openai", modelId))).toBe(true);
		},
	);
});
