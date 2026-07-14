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

	it("injects the JSON Schema instruction and parses structured completion output", async () => {
		// Given
		const complete = vi.fn(async () => textMessage('{"answer":42}'));
		const registry = { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })) };
		const schema = { type: "object", properties: { answer: { type: "number" } } };

		// When
		const result = await createCompletionHandler(complete)(context(registry))({ prompt: "json", schema });

		// Then
		expect(complete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						content: [
							{
								type: "text",
								text: 'json\n\nRespond ONLY with JSON matching this JSON-Schema:\n{"type":"object","properties":{"answer":{"type":"number"}}}',
							},
						],
					}),
				],
			}),
			expect.any(Object),
		);
		expect(result).toEqual({ value: { answer: 42 }, details: { model: "fake/fake-model", structured: true } });
	});

	it("returns schema parse failures as data", async () => {
		// Given
		const complete = vi.fn(async () => textMessage("not json at all"));
		const registry = { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })) };

		// When
		const result = await createCompletionHandler(complete)(context(registry))({
			prompt: "json",
			schema: { type: "object" },
		});

		// Then
		expect(result).toMatchObject({
			value: { parseError: expect.any(String) },
			details: { model: "fake/fake-model", structured: true },
		});
	});

	it("resolves the smol tier to the cheapest available model", async () => {
		// Given
		const cheapModel: FakeModel = {
			...model,
			id: "cheap-model",
			name: "Cheap Model",
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
		};
		const expensiveModel: FakeModel = {
			...model,
			id: "expensive-model",
			name: "Expensive Model",
			cost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
		};
		const complete = vi.fn(async () => textMessage("done"));
		const registry = {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })),
			getAvailable: vi.fn(() => [expensiveModel, cheapModel]),
		};

		// When
		const result = await createCompletionHandler(complete)(context(registry))({ prompt: "hello", model: "smol" });

		// Then
		expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(cheapModel);
		expect(complete).toHaveBeenCalledWith(cheapModel, expect.any(Object), expect.any(Object));
		expect(result).toEqual({ text: "done", details: { model: "fake/cheap-model", structured: false } });
	});

	it("resolves the slow tier to the most capable available model", async () => {
		// Given
		const cheapModel: FakeModel = {
			...model,
			id: "cheap-model",
			name: "Cheap Model",
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
		};
		const expensiveModel: FakeModel = {
			...model,
			id: "expensive-model",
			name: "Expensive Model",
			cost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
		};
		const complete = vi.fn(async () => textMessage("done"));
		const registry = {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })),
			getAvailable: vi.fn(() => [cheapModel, expensiveModel]),
		};

		// When
		const result = await createCompletionHandler(complete)(context(registry))({ prompt: "hello", model: "slow" });

		// Then
		expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(expensiveModel);
		expect(complete).toHaveBeenCalledWith(expensiveModel, expect.any(Object), expect.any(Object));
		expect(result).toEqual({ text: "done", details: { model: "fake/expensive-model", structured: false } });
	});

	it("names an unavailable tier when its registry has no available model", async () => {
		// Given
		const registry = {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })),
			getAvailable: vi.fn(() => []),
		};

		// When / Then
		await expect(createCompletionHandler()(context(registry))({ prompt: "hello", model: "smol" })).rejects.toThrow(
			'"smol" model tier',
		);
	});

	it("names an unknown model tier", async () => {
		// Given
		const registry = { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })) };

		// When / Then
		await expect(createCompletionHandler()(context(registry))({ prompt: "hello", model: "turbo" })).rejects.toThrow(
			'"turbo" model tier',
		);
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
});
