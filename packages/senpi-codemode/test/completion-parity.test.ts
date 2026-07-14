import type { ExtensionContext } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import { createCompletionHandler } from "../src/completion/handler.ts";

const model = {
	id: "fake-model",
	name: "Fake Model",
	provider: "fake",
	api: "fake-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
};

type StopReason = "stop" | "error" | "aborted";

type FakeAssistantMessage = {
	readonly role: "assistant";
	readonly content: { readonly type: "text"; readonly text: string }[];
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	readonly stopReason: StopReason;
	readonly errorMessage?: string;
	readonly usage: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly totalTokens: number;
		readonly cost: {
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
			readonly total: number;
		};
	};
	readonly timestamp: number;
};

function context(): ExtensionContext {
	return Object.assign(Object.create(null), {
		model,
		signal: undefined,
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })),
			getAvailable: () => [model],
		},
	});
}

function assistant(stopReason: StopReason, text = "", errorMessage?: string): FakeAssistantMessage {
	return {
		role: "assistant",
		content: text.length === 0 ? [] : [{ type: "text", text }],
		api: "fake-api",
		provider: "fake",
		model: "fake-model",
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
}

describe("completion bridge parity", () => {
	it("Given no system prompt when completion runs then a non-empty default instruction is sent", async () => {
		const complete = vi.fn(async () => assistant("stop", "ok"));

		// When
		await createCompletionHandler(complete)(context())({ prompt: "question" });

		// Then
		expect(complete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({ systemPrompt: "You are a helpful assistant." }),
			expect.any(Object),
		);
	});

	it("Given an explicit system prompt when completion runs then the caller instruction is preserved", async () => {
		const complete = vi.fn(async () => assistant("stop", "ok"));

		// When
		await createCompletionHandler(complete)(context())({ prompt: "question", system: "Be terse." });

		// Then
		expect(complete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({ systemPrompt: "Be terse." }),
			expect.any(Object),
		);
	});

	it.each([
		["error", "provider failed", "provider failed"],
		["aborted", undefined, "completion() request aborted"],
	] as const)("Given a %s stop reason when completion settles then the failure is surfaced", async (reason, errorMessage, expected) => {
		const complete = vi.fn(async () => assistant(reason, "", errorMessage));

		// When / Then
		await expect(createCompletionHandler(complete)(context())({ prompt: "question" })).rejects.toThrow(expected);
	});

	it("Given a successful message without text when completion settles then the empty result is rejected", async () => {
		const complete = vi.fn(async () => assistant("stop"));

		// When / Then
		await expect(createCompletionHandler(complete)(context())({ prompt: "question" })).rejects.toThrow(
			"completion() returned no text output",
		);
	});
});
