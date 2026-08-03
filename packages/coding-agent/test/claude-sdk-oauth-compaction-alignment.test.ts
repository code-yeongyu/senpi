import {
	type AssistantMessage,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import compactionExtension from "../src/core/extensions/builtin/compaction/index.ts";
import {
	CLAUDE_SDK_OAUTH_COMPACT_BOUNDARY_DIAGNOSTIC,
	SDK_NATIVE_LANE_REJECTION_REASON,
} from "../src/core/extensions/builtin/compaction/lane-policy.ts";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "../src/core/extensions/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const registrations: FauxProviderRegistration[] = [];
afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

type Handlers = {
	agentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;
	beforeAgentStart: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<unknown> | unknown;
	context: (event: ContextEvent, ctx: ExtensionContext) => { messages: unknown[] } | undefined;
	messageEnd: (event: MessageEndEvent, ctx: ExtensionContext) => Promise<unknown> | unknown;
	sessionBeforeCompact: (
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
	) => Promise<SessionBeforeCompactResult | undefined> | SessionBeforeCompactResult | undefined;
};

interface AlignmentHarness extends Handlers {
	ctx: ExtensionContext;
	appendEntry: ReturnType<typeof vi.fn>;
	beginCompaction: ReturnType<typeof vi.fn>;
	applyCompaction: ReturnType<typeof vi.fn>;
	getSystemPrompt: ReturnType<typeof vi.fn>;
	registration: FauxProviderRegistration;
}

function bigAssistantMessage(text: string): AssistantMessage {
	return fauxAssistantMessage(text, { timestamp: 2 }) as AssistantMessage;
}

function createHarness(options: { provider?: string; usageTokens?: number; contextWindow?: number }): AlignmentHarness {
	const registration = registerFauxProvider();
	registrations.push(registration);
	const fauxModel = registration.getModel();
	const model = options.provider ? { ...fauxModel, provider: options.provider } : fauxModel;
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	// Register the faux transport under BOTH ids so the only difference between the
	// lane case and the regression case is the provider id, never provider health.
	for (const providerId of new Set([fauxModel.provider, model.provider])) {
		authStorage.setRuntimeApiKey(providerId, "faux-key");
		modelRegistry.registerProvider(providerId, {
			baseUrl: fauxModel.baseUrl,
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
	}

	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "seed" }], timestamp: 1 });
	sessionManager.appendMessage(bigAssistantMessage("old context ".repeat(500)));
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "keep" }], timestamp: 3 });

	const handlers: Partial<Handlers> = {};
	const appendEntry = vi.fn();
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "agent_end") handlers.agentEnd = handler as Handlers["agentEnd"];
			if (event === "before_agent_start") handlers.beforeAgentStart = handler as Handlers["beforeAgentStart"];
			if (event === "context") handlers.context = handler as Handlers["context"];
			if (event === "message_end") handlers.messageEnd = handler as Handlers["messageEnd"];
			if (event === "session_before_compact")
				handlers.sessionBeforeCompact = handler as Handlers["sessionBeforeCompact"];
		},
		appendEntry,
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "off" as const,
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	}) as ExtensionAPI;
	compactionExtension(api);
	if (
		!handlers.agentEnd ||
		!handlers.beforeAgentStart ||
		!handlers.context ||
		!handlers.messageEnd ||
		!handlers.sessionBeforeCompact
	) {
		throw new Error("compaction extension did not register the expected handlers");
	}

	const contextWindow = options.contextWindow ?? 100_000;
	const usageTokens = options.usageTokens ?? 95_000;
	const beginCompaction = vi.fn(() => undefined);
	const applyCompaction = vi.fn(async () => ({ applied: true, reason: "ok" }));
	// Snapshot construction for every senpi compaction route reads the system prompt,
	// so this spy observes "senpi tried to compact" independently of provider health.
	const getSystemPrompt = vi.fn(() => "SYSTEM");
	const ctx = {
		hasUI: false,
		mode: "tui",
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
		getContextUsage: () => ({
			tokens: usageTokens,
			contextWindow,
			percent: (usageTokens / contextWindow) * 100,
		}),
		getCompactionSettings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1, reserveTokens: 1_000 }),
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction,
		beginCompaction,
		endCompaction: vi.fn(),
		updateCompaction: vi.fn(),
		getSystemPrompt,
	} as unknown as ExtensionContext;

	return {
		agentEnd: handlers.agentEnd,
		beforeAgentStart: handlers.beforeAgentStart,
		context: handlers.context,
		messageEnd: handlers.messageEnd,
		sessionBeforeCompact: handlers.sessionBeforeCompact,
		ctx,
		appendEntry,
		beginCompaction,
		applyCompaction,
		getSystemPrompt,
		registration,
	};
}

function beforeAgentStartEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "next",
		systemPrompt: "SYSTEM",
		systemPromptOptions: { cwd: process.cwd() },
	} as BeforeAgentStartEvent;
}

function beforeCompactEvent(): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: false,
		requestId: "request-1",
		preparation: {
			messages: [],
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		branchEntries: [],
		signal: new AbortController().signal,
	} as unknown as SessionBeforeCompactEvent;
}

describe("claude-sdk-oauth lane: senpi compaction stands down", () => {
	it("does not run blocking compaction on before_agent_start when over the hard limit", async () => {
		const harness = createHarness({ provider: "claude-sdk-oauth", usageTokens: 99_500 });
		harness.registration.setResponses([fauxAssistantMessage("must not be used")]);

		await harness.beforeAgentStart(beforeAgentStartEvent(), harness.ctx);

		expect(harness.beginCompaction).not.toHaveBeenCalled();
		expect(harness.applyCompaction).not.toHaveBeenCalled();
		expect(harness.registration.state.callCount).toBe(0);
	});

	it("does not warm speculative compaction at agent_end", async () => {
		const harness = createHarness({ provider: "claude-sdk-oauth", usageTokens: 80_000 });
		harness.registration.setResponses([fauxAssistantMessage("must not be used")]);

		await harness.agentEnd({ type: "agent_end", messages: [] }, harness.ctx);

		expect(harness.getSystemPrompt).not.toHaveBeenCalled();
		expect(harness.registration.state.callCount).toBe(0);
	});

	it("cancels a requested senpi compaction with the lane reason", async () => {
		const harness = createHarness({ provider: "claude-sdk-oauth" });

		const result = await harness.sessionBeforeCompact(beforeCompactEvent(), harness.ctx);

		expect(result).toMatchObject({ cancel: true, reason: SDK_NATIVE_LANE_REJECTION_REASON });
	});

	it("leaves context messages untouched while the same load reduces them for other providers", () => {
		const reductionMessages = () => [
			{ role: "user" as const, content: [{ type: "text" as const, text: "u1" }], timestamp: 1 },
			bigAssistantMessage("assistant answer ".repeat(4_000)),
			{ role: "user" as const, content: [{ type: "text" as const, text: "u2" }], timestamp: 3 },
		];
		const lane = createHarness({ provider: "claude-sdk-oauth", usageTokens: 95_000 });
		const other = createHarness({ usageTokens: 95_000 });

		const laneResult = lane.context({ type: "context", messages: reductionMessages() }, lane.ctx);
		const otherResult = other.context({ type: "context", messages: reductionMessages() }, other.ctx);
		const laneSize = JSON.stringify(laneResult?.messages).length;
		const otherSize = JSON.stringify(otherResult?.messages).length;

		expect(otherSize).toBeLessThan(laneSize);
	});
});

describe("non-claude-sdk-oauth providers keep senpi compaction (characterization)", () => {
	it("still runs blocking compaction on before_agent_start when over the hard limit", async () => {
		const harness = createHarness({ usageTokens: 99_500 });
		harness.registration.setResponses([fauxAssistantMessage("summary")]);

		await harness.beforeAgentStart(beforeAgentStartEvent(), harness.ctx);

		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);
	});

	it("still warms speculative compaction at agent_end", async () => {
		const harness = createHarness({ usageTokens: 80_000 });
		harness.registration.setResponses([fauxAssistantMessage("idle summary")]);

		await harness.agentEnd({ type: "agent_end", messages: [] }, harness.ctx);

		expect(harness.getSystemPrompt).toHaveBeenCalled();
	});

	it("still accepts senpi compaction requests", async () => {
		const harness = createHarness({});
		harness.registration.setResponses([fauxAssistantMessage("summary text")]);

		const result = await harness.sessionBeforeCompact(beforeCompactEvent(), harness.ctx);

		expect(result).not.toMatchObject({ reason: SDK_NATIVE_LANE_REJECTION_REASON });
	});
});

describe("compact_boundary mirroring into the senpi session ledger", () => {
	it("appends a claude-sdk-oauth-compact custom entry for a received boundary", async () => {
		const harness = createHarness({ provider: "claude-sdk-oauth" });
		const message = {
			...bigAssistantMessage("done"),
			provider: "claude-sdk-oauth",
			diagnostics: [
				{
					type: CLAUDE_SDK_OAUTH_COMPACT_BOUNDARY_DIAGNOSTIC,
					timestamp: 7,
					details: {
						type: "system",
						subtype: "compact_boundary",
						uuid: "33333333-3333-4333-8333-333333333333",
						session_id: "sdk-session-3",
						compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 30_000 },
					},
				},
			],
		} as AssistantMessage;

		await harness.messageEnd({ type: "message_end", message }, harness.ctx);

		expect(harness.appendEntry).toHaveBeenCalledWith("claude-sdk-oauth-compact", {
			schema: "senpi.claude-sdk-oauth.compact-boundary.v1",
			sdkSessionId: "sdk-session-3",
			uuid: "33333333-3333-4333-8333-333333333333",
			compactMetadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 30_000 },
		});
	});

	it("appends nothing for assistant messages without a boundary diagnostic", async () => {
		const harness = createHarness({ provider: "claude-sdk-oauth" });

		await harness.messageEnd({ type: "message_end", message: bigAssistantMessage("plain") }, harness.ctx);

		expect(harness.appendEntry).not.toHaveBeenCalled();
	});
});
