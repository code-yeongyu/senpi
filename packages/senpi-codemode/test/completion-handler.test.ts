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
	contextWindow: 1000,
	maxTokens: 100,
};

type FakeModel = typeof model;
type FakeAssistantMessage = {
	readonly role: "assistant";
	readonly content: { readonly type: "text"; readonly text: string }[];
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	readonly stopReason: "stop";
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

function context(
	registry: { getApiKeyAndHeaders: (input: FakeModel) => Promise<unknown> },
	currentModel?: FakeModel | null,
): ExtensionContext {
	return Object.assign(Object.create(null), {
		model: currentModel === undefined ? model : (currentModel ?? undefined),
		modelRegistry: registry,
		signal: undefined,
	});
}

function textMessage(text: string): FakeAssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "fake-api",
		provider: "fake",
		model: "fake-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("completion() handler", () => {
	it("uses ctx.model and ctx.modelRegistry credentials for text completion", async () => {
		const complete = vi.fn(async () => textMessage("done"));
		const registry = {
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true,
				apiKey: "runtime-key",
				headers: { "x-runtime": "yes" },
				env: { A: "B" },
			})),
		};

		const result = await createCompletionHandler(complete)(context(registry))({ prompt: "hello" });

		expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
		expect(complete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
			expect.objectContaining({ apiKey: "runtime-key", headers: { "x-runtime": "yes" }, env: { A: "B" } }),
		);
		expect(result).toEqual({ text: "done", details: { model: "fake/fake-model", structured: false } });
	});

	it("parses schema completion JSON into a structured value", async () => {
		const complete = vi.fn(async () => textMessage('{"answer":42}'));
		const registry = { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })) };

		const result = await createCompletionHandler(complete)(context(registry))({
			prompt: "json",
			schema: { type: "object", properties: { answer: { type: "number" } } },
		});

		expect(result).toEqual({ value: { answer: 42 }, details: { model: "fake/fake-model", structured: true } });
	});

	it("throws a typed no model/credentials error when no current model is available", async () => {
		const registry = { getApiKeyAndHeaders: vi.fn() };

		await expect(createCompletionHandler()(context(registry, null))({ prompt: "hello" })).rejects.toThrow(
			"completion() has no model/credentials",
		);
		expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("throws a typed no model/credentials error when registry has no credentials", async () => {
		const registry = { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })) };

		await expect(createCompletionHandler()(context(registry))({ prompt: "hello" })).rejects.toThrow(
			"completion() has no model/credentials",
		);
	});

	it("rejects unsupported role aliases instead of inventing smol/slow roles", async () => {
		const registry = { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })) };

		await expect(createCompletionHandler()(context(registry))({ prompt: "hello", model: "smol" })).rejects.toThrow(
			"completion() model roles are not supported",
		);
	});
});
