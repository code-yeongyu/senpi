import {
	createAssistantMessageEventStream,
	type FauxModelDefinition,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	vi.restoreAllMocks();
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
		cwd: process.cwd(),
		model,
		modelRegistry,
		sessionManager,
		getContextUsage: () => ({ tokens: 50_000, contextWindow: model.contextWindow, percent: 25 }),
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
}

function createPendingSummary() {
	const model: FauxModelDefinition = {
		id: "faux-compaction-abort",
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
	const registration = registerFauxProvider({ models: [model] });
	registrations.push(registration);
	const context = createContext(registration);
	const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
	if (!snapshot) throw new Error("expected a compaction snapshot");

	const stream = createAssistantMessageEventStream();
	const started = Promise.withResolvers<void>();
	vi.spyOn(context.modelRegistry!.modelRuntime, "stream").mockImplementation(() => {
		started.resolve();
		return stream;
	});

	return { context, snapshot, started: started.promise, stream };
}

describe("speculative compaction stream cancellation", () => {
	it("treats a late stream rejection after caller abort as cancellation", async () => {
		const { context, snapshot, started, stream } = createPendingSummary();
		const controller = new AbortController();

		const result = runExtensionCompaction(context, snapshot, controller.signal);
		await started;
		controller.abort();
		stream.fail(new Error("Assistant message stream consumption was cancelled"));

		await expect(result).resolves.toBeUndefined();
	});

	it("still surfaces a stream rejection when the caller did not abort", async () => {
		const { context, snapshot, started, stream } = createPendingSummary();
		const failure = new Error("provider stream failed");

		const result = runExtensionCompaction(context, snapshot);
		await started;
		stream.fail(failure);

		await expect(result).rejects.toBe(failure);
	});
});
