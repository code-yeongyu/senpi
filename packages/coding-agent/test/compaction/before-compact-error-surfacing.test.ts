import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "../../src/core/extensions/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";

type Registration = FauxProviderRegistration;

const registrations: Registration[] = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

interface Harness {
	beforeCompact: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>;
	registration: Registration;
	notifications: Array<{ message: string; level: string | undefined }>;
	ctx: ExtensionContext;
}

function createHarness(): Harness {
	const registration = registerFauxProvider();
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

	let beforeCompact: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult> | undefined;
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "session_before_compact") {
				beforeCompact = handler as ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>;
			}
		},
		appendEntry: vi.fn(),
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "off" as const,
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	}) as ExtensionAPI;
	compactionExtension(api);
	if (!beforeCompact) throw new Error("session_before_compact handler was not registered");

	const notifications: Array<{ message: string; level: string | undefined }> = [];
	const ctx = {
		hasUI: false,
		mode: "print",
		ui: Object.assign(Object.create(null), {
			notify: (message: string, level?: string) => {
				notifications.push({ message, level });
			},
		}) as ExtensionContext["ui"],
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
		} as unknown as ExtensionContext["sessionManager"],
		modelRegistry,
		model,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens: 50_000, contextWindow: model.contextWindow, percent: 25 }),
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		beginCompaction: () => undefined,
		endCompaction: vi.fn(),
		getSystemPrompt: () => "TEST AGENT SYSTEM PROMPT",
	} as unknown as ExtensionContext;

	return { beforeCompact, registration, notifications, ctx };
}

function createPreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [
			{ role: "user", content: [{ type: "text", text: "please fix the bug" }], timestamp: Date.now() },
		],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 90_000,
		fileOps: { read: new Set(), edited: new Set(), written: new Set() },
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function createEvent(): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "manual",
		willRetry: false,
		requestId: "manual-compact-1",
		preparation: createPreparation(),
		branchEntries: [],
		signal: new AbortController().signal,
	};
}

describe("session_before_compact error surfacing", () => {
	it("notifies the real provider error and cancels when summarization fails", async () => {
		// Given
		const harness = createHarness();
		harness.registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "faux: request blocked by provider policy",
			}),
		]);

		// When
		const result = await harness.beforeCompact(createEvent(), harness.ctx);

		// Then
		expect(result).toEqual({ cancel: true });
		expect(harness.notifications).toHaveLength(1);
		expect(harness.notifications[0]?.message).toContain("request blocked by provider policy");
		expect(harness.notifications[0]?.level).toBe("error");
	});

	it("returns the generated compaction with the agent system prompt on the request", async () => {
		// Given
		const harness = createHarness();
		harness.registration.setResponses([fauxAssistantMessage("manual summary")]);

		// When
		const result = await harness.beforeCompact(createEvent(), harness.ctx);

		// Then
		expect(result && "compaction" in result ? result.compaction?.summary : undefined).toBe("manual summary");
		expect(harness.notifications).toHaveLength(0);
		const call = harness.registration.getCallLog()[0];
		expect(call?.context.systemPrompt).toBe("TEST AGENT SYSTEM PROMPT");
	});
});
