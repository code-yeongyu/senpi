import { type FauxModelDefinition, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	createSpeculativeCompactionSnapshot,
	runExtensionCompaction,
	type SpeculativeCompactionContext,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const registrations: Array<{ unregister: () => void }> = [];

type Registration = ReturnType<typeof registerFauxProvider>;

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function createContext(registration: Registration): SpeculativeCompactionContext {
	const model = registration.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: registration.api,
		models: registration.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
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
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
}

async function captureSummarizationOptions(
	api: string,
	models: FauxModelDefinition[],
): Promise<Record<string, unknown> | undefined> {
	const registration = registerFauxProvider({ api, models });
	registrations.push(registration);
	registration.setResponses([fauxAssistantMessage("summary")]);
	const context = createContext(registration);
	const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
	if (!snapshot) throw new Error("expected a compaction snapshot");
	await runExtensionCompaction(context, snapshot);
	const calls = registration.getCallLog();
	if (calls.length !== 1) throw new Error(`expected exactly one summarization call, got ${calls.length}`);
	return calls[0]?.options as Record<string, unknown> | undefined;
}

const reasoningModel: FauxModelDefinition = {
	id: "faux-reasoning",
	reasoning: true,
	contextWindow: 128_000,
	maxTokens: 16_384,
};

describe("summarization reasoning overrides", () => {
	it("disables thinking for anthropic-messages summarization", async () => {
		const options = await captureSummarizationOptions("anthropic-messages", [reasoningModel]);
		expect(options?.thinkingEnabled).toBe(false);
	});

	it("minimizes reasoning for openai-responses summarization", async () => {
		const options = await captureSummarizationOptions("openai-responses", [reasoningModel]);
		expect(options?.reasoningEffort).toBe("minimal");
		expect(options?.reasoningSummary).toBeNull();
	});

	it("minimizes reasoning for openai-completions summarization", async () => {
		const options = await captureSummarizationOptions("openai-completions", [reasoningModel]);
		expect(options?.reasoningEffort).toBe("minimal");
	});

	it("leaves non-reasoning models untouched", async () => {
		const options = await captureSummarizationOptions("anthropic-messages", [
			{ ...reasoningModel, id: "faux-plain", reasoning: false },
		]);
		expect(options?.thinkingEnabled).toBeUndefined();
		expect(options?.reasoningEffort).toBeUndefined();
	});
});
