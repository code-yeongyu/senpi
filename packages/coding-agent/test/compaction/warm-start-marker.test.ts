import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import {
	runExtensionCompaction,
	type SpeculativeCompactionContext,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import {
	type CompactionEntry,
	migrateSessionEntries,
	parseSessionEntries,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { createHarness } from "../suite/harness.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function createContext(): SpeculativeCompactionContext & {
	registration: ReturnType<typeof registerFauxProvider>;
	sessionManager: SessionManager;
} {
	const registration = registerFauxProvider();
	registrations.push(registration);
	const model = registration.getModel()!;
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
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "first user" }], timestamp: 1 });
	sessionManager.appendMessage({
		...fauxAssistantMessage("first assistant"),
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 2,
	});
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "second user" }], timestamp: 3 });
	return {
		cwd: process.cwd(),
		model,
		modelRegistry,
		registration,
		sessionManager,
		getContextUsage: () => ({ tokens: 50_000, contextWindow: model.contextWindow, percent: 25 }),
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
}

describe("warm-start marker", () => {
	it("stamps origin on speculative compaction details", async () => {
		const context = createContext();
		const snapshot = {
			generation: 1,
			expectedRevision: 1,
			model: context.model!,
			contextWindow: context.model!.contextWindow,
			preparation: {
				firstKeptEntryId: "x",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1,
				fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
				settings: DEFAULT_COMPACTION_SETTINGS,
			},
			promptVariant: "default" as const,
			origin: "speculative" as const,
		};
		context.registration.setResponses([fauxAssistantMessage("summary text")]);
		const result = await runExtensionCompaction(context, snapshot);
		expect(result).toBeDefined();
		expect(result?.details).toMatchObject({ schema: "senpi.compaction.summary.v1", origin: "speculative" });
	});

	it("parses legacy local entries without origin and keeps remote-schema entries without origin", async () => {
		const remoteEntries = parseSessionEntries(
			[
				JSON.stringify({
					type: "compaction",
					id: "r1",
					parentId: "p1",
					timestamp: "2026-01-01T00:00:00.000Z",
					details: {
						schema: "senpi.compaction.openai-remote.v1",
						mode: "openai-remote",
						provider: "openai",
						api: "openai-responses",
						transport: "compact-endpoint",
						modelId: "gpt-5.4",
						responseId: "resp_1",
						createdAt: 1,
						requestInputItemCount: 1,
						retainedInputItemCount: 1,
						replacementInput: [],
					},
				}),
			].join("\n"),
		);
		const remoteEntry = remoteEntries.find((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(remoteEntry?.details).not.toHaveProperty("origin");

		const legacyEntries = parseSessionEntries(
			[
				JSON.stringify({
					type: "compaction",
					id: "l1",
					parentId: "p1",
					timestamp: "2026-01-01T00:00:00.000Z",
					details: {
						schema: "senpi.compaction.summary.v1",
						promptVariant: "default",
						tokenEstimate: 123,
					},
				}),
			].join("\n"),
		);
		migrateSessionEntries(legacyEntries);
		const legacyEntry = legacyEntries.find((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(legacyEntry?.details).toMatchObject({ schema: "senpi.compaction.summary.v1", promptVariant: "default" });
		expect(legacyEntry?.details).not.toHaveProperty("origin");
	});

	it("stays aligned with the existing speculative compaction harness shape", async () => {
		const api = `warm-start-${Math.random().toString(36).slice(2)}`;
		const provider = `warm-start-provider-${Math.random().toString(36).slice(2)}`;
		const harness = await createHarness({
			api,
			provider,
			models: [{ id: "warm-start-model", contextWindow: 32_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [],
		});
		try {
			expect(harness.getModel()).toBeDefined();
			expect(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens).toBeGreaterThan(0);
		} finally {
			harness.cleanup();
		}
	});
});
