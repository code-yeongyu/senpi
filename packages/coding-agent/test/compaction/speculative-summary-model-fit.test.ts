import { fauxAssistantMessage, type FauxModelDefinition, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	createSpeculativeCompactionSnapshot,
	runExtensionCompaction,
	type SpeculativeCompactionContext,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

// oh-my-openagent#9698: the summary request carries the session system prompt, so a compaction model whose window
// cannot hold it failed every speculative request. The system prompt now counts against the input budget, and such a
// model gives way to the session model.

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function setup(
	models: FauxModelDefinition[],
	systemPrompt: string,
	options: { compactionModelId?: string; turns?: number; turnRepeat?: number } = {},
) {
	const { compactionModelId, turns = 1, turnRepeat = 12_000 } = options;
	const registration = registerFauxProvider({ models });
	registrations.push(registration);
	const model = registration.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: registration.api,
		models: registration.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			cost: registered.cost,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			baseUrl: registered.baseUrl,
		})),
	});
	const sessionManager = SessionManager.inMemory();
	for (let turn = 0; turn < turns; turn++) {
		const assistant = fauxAssistantMessage(`answer ${turn} `.repeat(turnRepeat));
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `question ${turn} `.repeat(turnRepeat) }],
			timestamp: Date.now() - 10_000 + turn,
		});
		sessionManager.appendMessage({ ...assistant, api: model.api, provider: model.provider, model: model.id });
	}
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "latest question ".repeat(turnRepeat) }],
		timestamp: Date.now(),
	});
	const compactionModel = compactionModelId === undefined ? undefined : registration.getModel(compactionModelId);
	const context: SpeculativeCompactionContext = {
		cwd: process.cwd(),
		model,
		modelRegistry,
		sessionManager,
		getContextUsage: () => ({ tokens: 100_000, contextWindow: model.contextWindow, percent: 50 }),
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
		getSystemPrompt: () => systemPrompt,
		...(compactionModel ? { getCompactionModel: () => compactionModel } : {}),
	};
	registration.setResponses([fauxAssistantMessage("summary")]);
	return { context, registration };
}

function requestTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

describe("speculative summary request fit (oh-my-openagent#9698)", () => {
	it("summarizes on the session model when the compaction model cannot hold the system prompt", async () => {
		const { context, registration } = setup(
			[
				{ id: "faux-main", contextWindow: 400_000, maxTokens: 32_000 },
				{ id: "faux-side", contextWindow: 16_000, maxTokens: 4_000 },
			],
			"session system prompt ".repeat(2_000),
			{ compactionModelId: "faux-side" },
		);
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		if (!snapshot) throw new Error("expected snapshot");

		const result = await runExtensionCompaction(context, snapshot);

		expect(result?.summary).toBe("summary");
		expect(registration.getCallLog().map((call) => call.modelId)).toEqual(["faux-main"]);
	});

	it("keeps system prompt plus history inside the session model's input budget", async () => {
		const contextWindow = 200_000;
		const systemPrompt = "session system prompt ".repeat(10_000);
		const { context, registration } = setup([{ id: "faux-main", contextWindow, maxTokens: 32_000 }], systemPrompt, {
			turns: 60,
			turnRepeat: 600,
		});
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		if (!snapshot) throw new Error("expected snapshot");

		await runExtensionCompaction(context, snapshot);

		const sent = registration.getCallLog()[0]?.context;
		const historyTokens = requestTokens(JSON.stringify(sent?.messages ?? []));
		expect(requestTokens(sent?.systemPrompt ?? "") + historyTokens).toBeLessThanOrEqual(contextWindow * 0.6 * 1.1);
	});
});
