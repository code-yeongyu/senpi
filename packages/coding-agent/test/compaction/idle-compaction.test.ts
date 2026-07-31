import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "../../src/core/extensions/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

type Registration = FauxProviderRegistration;
const registrations: Registration[] = [];
afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

interface IdleHarness {
	agentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;
	beforeAgentStart: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<unknown> | unknown;
	registration: Registration;
	ctx: ExtensionContext;
	applyCompaction: ReturnType<typeof vi.fn>;
	beginCompaction: ReturnType<typeof vi.fn>;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("deferred resolver was not initialized");
	return { promise, resolve };
}

function createIdleHarness(options: {
	mode?: ExtensionContext["mode"];
	usageTokens?: number;
	contextWindow?: number;
	idleCompactionEnabled?: boolean;
}): IdleHarness {
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
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "seed user" }],
		timestamp: now - 2000,
	});
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "seed user two" }],
		timestamp: now - 1000,
	});
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "keep" }], timestamp: now });

	let agentEnd: IdleHarness["agentEnd"] | undefined;
	let beforeAgentStart: IdleHarness["beforeAgentStart"] | undefined;
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "agent_end") agentEnd = handler as IdleHarness["agentEnd"];
			if (event === "before_agent_start") beforeAgentStart = handler as IdleHarness["beforeAgentStart"];
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
	if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");

	const applyCompaction = vi.fn(async () => ({ applied: true, reason: "ok" }));
	const beginCompaction = vi.fn(() => undefined);
	const contextWindow = options.contextWindow ?? 100_000;
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };
	if (options.idleCompactionEnabled === false) settings.idleCompactionEnabled = false;
	const ctx = {
		hasUI: false,
		mode: options.mode ?? "tui",
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
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens: options.usageTokens ?? 80_000, contextWindow, percent: 80 }),
		getCompactionSettings: () => settings,
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction,
		beginCompaction,
		endCompaction: vi.fn(),
		updateCompaction: vi.fn(),
		getSystemPrompt: () => "TEST AGENT SYSTEM PROMPT",
	} as unknown as ExtensionContext;

	return { agentEnd, beforeAgentStart, registration, ctx, applyCompaction, beginCompaction };
}

function createAgentEndEvent(overrides?: Partial<AgentEndEvent>): AgentEndEvent {
	return { type: "agent_end", messages: [], ...overrides };
}

describe("proactive idle compaction (agent_end wiring)", () => {
	it("warms compaction at idle without committing a durable boundary", async () => {
		const harness = createIdleHarness({});
		const summaryRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				summaryRequested.resolve();
				return fauxAssistantMessage("idle compaction summary");
			},
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await summaryRequested.promise;

		expect(harness.registration.state.callCount).toBe(1);
		expect(harness.beginCompaction).not.toHaveBeenCalled();
		expect(harness.applyCompaction).not.toHaveBeenCalled();

		await harness.beforeAgentStart(
			{
				type: "before_agent_start",
				prompt: "next prompt",
				systemPrompt: "TEST AGENT SYSTEM PROMPT",
				systemPromptOptions: { cwd: process.cwd() },
			},
			harness.ctx,
		);

		expect(harness.beginCompaction).toHaveBeenCalledTimes(1);
		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);
	});

	it("does not compact at idle when the run will auto-continue", async () => {
		const harness = createIdleHarness({});
		harness.registration.setResponses([fauxAssistantMessage("should not be used")]);

		await harness.agentEnd(createAgentEndEvent({ willRetry: true }), harness.ctx);

		expect(harness.beginCompaction).not.toHaveBeenCalled();
		expect(harness.applyCompaction).not.toHaveBeenCalled();
	});

	it("does not compact at idle when the run was aborted", async () => {
		const harness = createIdleHarness({});
		harness.registration.setResponses([fauxAssistantMessage("should not be used")]);

		await harness.agentEnd(createAgentEndEvent({ aborted: true }), harness.ctx);

		expect(harness.beginCompaction).not.toHaveBeenCalled();
	});

	it("does not compact at idle in one-shot print mode", async () => {
		const harness = createIdleHarness({ mode: "print" });
		harness.registration.setResponses([fauxAssistantMessage("should not be used")]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);

		expect(harness.beginCompaction).not.toHaveBeenCalled();
	});

	it("does not compact at idle in one-shot json mode", async () => {
		const harness = createIdleHarness({ mode: "json" });
		harness.registration.setResponses([fauxAssistantMessage("should not be used")]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);

		expect(harness.beginCompaction).not.toHaveBeenCalled();
	});

	it("does not compact at idle when idleCompactionEnabled is false", async () => {
		const harness = createIdleHarness({ idleCompactionEnabled: false });
		harness.registration.setResponses([fauxAssistantMessage("should not be used")]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);

		expect(harness.beginCompaction).not.toHaveBeenCalled();
	});

	it("does not compact at idle when below the compaction threshold", async () => {
		const harness = createIdleHarness({ usageTokens: 1_000, contextWindow: 100_000 });
		harness.registration.setResponses([fauxAssistantMessage("should not be used")]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);

		expect(harness.beginCompaction).not.toHaveBeenCalled();
	});
});
