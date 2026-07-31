import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/index.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("deferred resolver was not initialized");
	return { promise, resolve };
}

function createHarness(idleCompactionEnabled: boolean, hasPendingMessages = false) {
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

	const sessionManager = SessionManager.inMemory();
	const now = Date.now();
	for (const index of [2_000, 1_000, 0]) {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `seed ${index}` }],
			timestamp: now - index,
		});
	}

	let agentEnd: ((event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "agent_end") {
				agentEnd = handler as (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;
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
	if (!agentEnd) throw new Error("agent_end handler was not registered");

	const applyCompaction = vi.fn(async () => ({ applied: true, reason: "ok" }));
	const beginCompaction = vi.fn(() => undefined);
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1, idleCompactionEnabled };
	const ctx = {
		hasUI: false,
		mode: "rpc",
		ui: Object.assign(Object.create(null), { notify: vi.fn() }),
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry,
		model,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => hasPendingMessages,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
		getCompactionSettings: () => settings,
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction,
		beginCompaction,
		endCompaction: vi.fn(),
		updateCompaction: vi.fn(),
		getSystemPrompt: () => "TEST AGENT SYSTEM PROMPT",
	} as unknown as ExtensionContext;

	return { registration, agentEnd, ctx, applyCompaction, beginCompaction };
}

describe("issue #561 idle compaction boundary", () => {
	it("warms the summary without committing a compaction at agent_end", async () => {
		const harness = createHarness(true);
		const summaryRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				summaryRequested.resolve();
				return fauxAssistantMessage("idle summary");
			},
		]);

		await harness.agentEnd({ type: "agent_end", messages: [] }, harness.ctx);
		await summaryRequested.promise;

		expect(harness.registration.state.callCount).toBe(1);
		expect(harness.beginCompaction).not.toHaveBeenCalled();
		expect(harness.applyCompaction).not.toHaveBeenCalled();
	});

	it("does nothing when idle compaction is disabled", async () => {
		const harness = createHarness(false);
		harness.registration.setResponses([fauxAssistantMessage("unused summary")]);

		await harness.agentEnd({ type: "agent_end", messages: [] }, harness.ctx);

		expect(harness.registration.state.callCount).toBe(0);
		expect(harness.beginCompaction).not.toHaveBeenCalled();
		expect(harness.applyCompaction).not.toHaveBeenCalled();
	});

	it("does not commit a boundary while a follow-up is queued at idle", async () => {
		const harness = createHarness(true, true);
		const summaryRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				summaryRequested.resolve();
				return fauxAssistantMessage("queued idle summary");
			},
		]);

		await harness.agentEnd({ type: "agent_end", messages: [] }, harness.ctx);
		await summaryRequested.promise;

		expect(harness.registration.state.callCount).toBe(1);
		expect(harness.beginCompaction).not.toHaveBeenCalled();
		expect(harness.applyCompaction).not.toHaveBeenCalled();
	});
});
