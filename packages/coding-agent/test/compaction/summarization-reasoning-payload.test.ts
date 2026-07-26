import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	createSpeculativeCompactionSnapshot,
	runExtensionCompaction,
	type SpeculativeCompactionContext,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

type ReasoningPayload = {
	reasoning?: { effort?: string; summary?: string };
	reasoning_effort?: string;
};

function createContext(model: Model<any>, capture: (payload: ReasoningPayload) => never): SpeculativeCompactionContext {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "fake-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		api: model.api,
		apiKey: "fake-key",
		baseUrl: model.baseUrl,
		models: [model],
	});
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "first user ".repeat(12_000) }],
		timestamp: Date.now() - 3_000,
	});
	sessionManager.appendMessage({
		...fauxAssistantMessage("first assistant ".repeat(12_000), { timestamp: Date.now() - 2_000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 50_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 50_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "second user ".repeat(12_000) }],
		timestamp: Date.now() - 1_000,
	});

	return {
		model,
		modelRegistry,
		sessionManager,
		getContextUsage: () => ({ tokens: 50_000, contextWindow: model.contextWindow, percent: 25 }),
		getMessageRevision: () => 1,
		prepareProviderRequest: async (messages) => ({
			messages,
			transformHeaders: async (headers) => headers,
			transformPayload: async (payload) => capture(payload as ReasoningPayload),
		}),
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
}

async function captureSummaryPayload(model: Model<any>): Promise<ReasoningPayload> {
	let captured: ReasoningPayload | undefined;
	const sentinel = new Error("payload captured");
	const context = createContext(model, (payload) => {
		captured = payload;
		throw sentinel;
	});
	const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
	if (!snapshot) throw new Error("expected a compaction snapshot");

	let failure: unknown;
	try {
		await runExtensionCompaction(context, snapshot);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toBe(sentinel.message);
	if (!captured) throw new Error("expected the provider payload hook to run");
	return captured;
}

const payloadCases = [
	{
		name: "OpenAI Responses",
		model: { ...getModel("openai", "gpt-5.4"), baseUrl: "http://127.0.0.1:9" },
		effort: "low",
		summary: undefined,
	},
	{
		name: "Codex Responses",
		model: { ...getModel("openai-codex", "gpt-5.4"), baseUrl: "http://127.0.0.1:9" },
		effort: "low",
		summary: "off",
	},
	{
		name: "Azure Responses",
		model: {
			...getModel("azure-openai-responses", "gpt-5.4"),
			baseUrl: "https://test-resource.openai.azure.com/openai/v1",
		},
		effort: "minimal",
		summary: undefined,
	},
] as const;

describe("compaction summarization provider payloads", () => {
	it.each(payloadCases)("uses the cheapest legal effort without a summary for $name", async ({
		model,
		effort,
		summary,
	}) => {
		const payload = await captureSummaryPayload(model);
		expect(payload.reasoning?.effort).toBe(effort);
		expect(payload.reasoning?.summary).toBe(summary);
	});

	it("uses low reasoning for Kimi when its catalog rejects minimal", async () => {
		const model = { ...getModel("moonshotai", "kimi-k3"), baseUrl: "http://127.0.0.1:9" };
		const payload = await captureSummaryPayload(model);
		expect(payload.reasoning_effort).toBe("low");
	});
});
