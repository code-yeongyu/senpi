import { type FauxModelDefinition, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { MERGED_COMPACTION_PROMPT_SYSTEM } from "../../src/core/extensions/builtin/compaction/prompts.ts";
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

const grokModel: FauxModelDefinition = {
	id: "grok-4.6",
	reasoning: true,
	contextWindow: 500_000,
	maxTokens: 32_768,
};

const agentSystemPrompt =
	"I read this as [intent] - [plan]. I'll stop when [the exact, observable condition that ends this turn].";

const agentTools = [
	{
		name: "read",
		description: "Read a file",
		parameters: { type: "object" as const, properties: {} },
	},
	{
		name: "bash",
		description: "Run a command",
		parameters: { type: "object" as const, properties: {} },
	},
];

function createContext(options: {
	api: string;
	provider: string;
	models: FauxModelDefinition[];
}): SpeculativeCompactionContext & { registration: Registration } {
	const registration = registerFauxProvider(options);
	registrations.push(registration);
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
		registration,
		sessionManager,
		getContextUsage: () => ({ tokens: 50_000, contextWindow: model.contextWindow, percent: 25 }),
		getMessageRevision: () => 1,
		getSystemPrompt: () => agentSystemPrompt,
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
}

async function captureSummarizationContext(options: { api: string; provider: string; models: FauxModelDefinition[] }) {
	const context = createContext(options);
	context.registration.setResponses([fauxAssistantMessage("structured handoff summary")]);
	const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1, tools: agentTools });
	if (!snapshot) throw new Error("expected a compaction snapshot");
	await runExtensionCompaction(context, snapshot);
	const call = context.registration.getCallLog()[0];
	if (!call) throw new Error("expected a summarization request");
	return call.context;
}

describe("Grok family summarization request shape", () => {
	it("does not send the agent IntentGate prompt or tools for cliproxy grok-4.6", async () => {
		const context = await captureSummarizationContext({
			api: "faux-cliproxy-grok",
			provider: "cliproxy",
			models: [grokModel],
		});

		expect(context.systemPrompt).toBe(MERGED_COMPACTION_PROMPT_SYSTEM);
		expect(context.systemPrompt).not.toContain("I read this as");
		expect(context.tools).toBeUndefined();
	});

	it("does not send the agent IntentGate prompt or tools for xAI grok", async () => {
		const context = await captureSummarizationContext({
			api: "faux-xai-grok",
			provider: "xai",
			models: [{ ...grokModel, id: "grok-4.5" }],
		});

		expect(context.systemPrompt).toBe(MERGED_COMPACTION_PROMPT_SYSTEM);
		expect(context.tools).toBeUndefined();
	});

	it("keeps the Anthropic anti-distillation agent-shaped summarization request", async () => {
		const context = await captureSummarizationContext({
			api: "faux-anthropic-messages",
			provider: "anthropic",
			models: [{ id: "claude-opus-4-6", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 }],
		});

		expect(context.systemPrompt).toBe(agentSystemPrompt);
		expect(context.tools?.map((tool) => tool.name)).toEqual(["read", "bash"]);
	});

	it("keeps GPT agent-shaped summarization so Claude/GPT compact stays unchanged", async () => {
		const context = await captureSummarizationContext({
			api: "faux-openai-responses",
			provider: "openai",
			models: [{ id: "gpt-5.4", reasoning: true, contextWindow: 272_000, maxTokens: 16_384 }],
		});

		expect(context.systemPrompt).toBe(agentSystemPrompt);
		expect(context.tools?.map((tool) => tool.name)).toEqual(["read", "bash"]);
	});
});
