import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	createSpeculativeCompactionSnapshot,
	runExtensionCompaction,
	type SpeculativeCompactionContext,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

// oh-my-openagent#10092: the speculative summary request carried no sessionId, so session-routed
// providers that require one (OpenCode Go: `x-opencode-session`, added only from `options.sessionId`)
// rejected every speculative compaction with `400 MissingSessionID`.

const registrations: Array<ReturnType<typeof registerFauxProvider>> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function speculativeContext(): SpeculativeCompactionContext {
	const registration = registerFauxProvider({
		api: "openai-completions",
		models: [{ id: "faux-summary", contextWindow: 128_000, maxTokens: 16_384 }],
	});
	registrations.push(registration);
	registration.setResponses([fauxAssistantMessage("summary")]);
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
	for (const [index, text] of ["first user ", "second user "].entries()) {
		if (index > 0) {
			sessionManager.appendMessage({
				...fauxAssistantMessage("assistant ".repeat(12_000), { timestamp: Date.now() - 2_000 }),
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
		}
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: text.repeat(12_000) }],
			timestamp: Date.now() - 3_000 + index * 2_000,
		});
	}
	return {
		cwd: process.cwd(),
		model,
		modelRegistry,
		sessionManager,
		getContextUsage: () => ({ tokens: 50_000, contextWindow: model.contextWindow, percent: 40 }),
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
}

describe("oh-my-openagent#10092 speculative summary session identity", () => {
	it("sends a fresh request sessionId with affinity to the compacted session", async () => {
		const context = speculativeContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		if (!snapshot) throw new Error("expected a compaction snapshot");

		await runExtensionCompaction(context, snapshot);

		const calls = registrations[0]?.getCallLog() ?? [];
		expect(calls).toHaveLength(1);
		const options = calls[0]?.options as { sessionId?: unknown; affinitySessionId?: unknown } | undefined;
		expect(options?.sessionId).toEqual(expect.any(String));
		expect(options?.sessionId).not.toBe(context.sessionManager.getSessionId());
		expect(options?.affinitySessionId).toBe(context.sessionManager.getSessionId());
	});
});
