/**
 * Idle-apply: when the idle warm-up summary finishes generating while the
 * session is STILL idle and the context is still over threshold, the extension
 * applies it right away instead of holding it warm until the next prompt. The
 * user then sees the [compaction] block during the idle gap, and their next
 * message stacks below it.
 *
 * CompactionReason choice: "extension".
 * Every senpi-extension-owned apply already carries `reason: "extension"`
 * (`applyGeneratedCompaction` in speculative.ts hardcodes it, and the blocking
 * route's begin/end feedback uses it too). The idle apply is the same actor -
 * the builtin compaction extension applying its own precomputed summary with no
 * core admission behind it - so reusing "extension" keeps `session_compact`
 * route labelling, the circuit-breaker route attribution, and the TUI's
 * "Compacting context..." indicator identical to every other extension-owned
 * apply. "threshold" is reserved for core's own admission path
 * (`_getRequiredAutoCompactionReason`) and would mislabel this as a
 * core-triggered auto-compaction in telemetry and in the status indicator
 * ("Auto-compacting...").
 */
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "../../src/core/extensions/builtin/claude-sdk-oauth/account-management.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionCompactEvent,
} from "../../src/core/extensions/index.ts";
import type { ApplyCompactionResult } from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

type Registration = FauxProviderRegistration;
const registrations: Registration[] = [];
afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

interface IdleApplyHarness {
	agentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;
	beforeAgentStart: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<unknown> | unknown;
	sessionCompact: (event: SessionCompactEvent, ctx: ExtensionContext) => Promise<unknown> | unknown;
	registration: Registration;
	ctx: ExtensionContext;
	sessionManager: SessionManager;
	applyCompaction: ReturnType<typeof vi.fn>;
	beginCompaction: ReturnType<typeof vi.fn>;
	setMessageRevision: (revision: number) => void;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("deferred resolver was not initialized");
	return { promise, resolve };
}

/** Let the idle continuation chain (generation -> guards -> apply) settle. */
async function settleIdleContinuation(): Promise<void> {
	for (let tick = 0; tick < 12; tick++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function createIdleApplyHarness(options: {
	usageTokens?: number;
	contextWindow?: number;
	idleCompactionEnabled?: boolean;
	provider?: string;
	applyCompactionResult?: () => Promise<ApplyCompactionResult>;
}): IdleApplyHarness {
	const registration = registerFauxProvider();
	registrations.push(registration);
	const baseModel = registration.getModel();
	const model = options.provider ? { ...baseModel, provider: options.provider } : baseModel;
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(baseModel.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(baseModel.provider, {
		baseUrl: baseModel.baseUrl,
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

	let agentEnd: IdleApplyHarness["agentEnd"] | undefined;
	let beforeAgentStart: IdleApplyHarness["beforeAgentStart"] | undefined;
	let sessionCompact: IdleApplyHarness["sessionCompact"] | undefined;
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "agent_end") agentEnd = handler as IdleApplyHarness["agentEnd"];
			if (event === "before_agent_start") beforeAgentStart = handler as IdleApplyHarness["beforeAgentStart"];
			if (event === "session_compact") sessionCompact = handler as IdleApplyHarness["sessionCompact"];
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
	if (!sessionCompact) throw new Error("session_compact handler was not registered");

	const applyCompaction = vi.fn(
		options.applyCompactionResult ?? (async () => ({ applied: true as const, reason: "ok" as const })),
	);
	const beginCompaction = vi.fn(() => undefined);
	const contextWindow = options.contextWindow ?? 100_000;
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };
	if (options.idleCompactionEnabled === false) settings.idleCompactionEnabled = false;
	let messageRevision = 1;
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
		getContextUsage: () => ({ tokens: options.usageTokens ?? 80_000, contextWindow, percent: 80 }),
		getCompactionSettings: () => settings,
		compact: vi.fn(),
		getMessageRevision: () => messageRevision,
		applyCompaction,
		beginCompaction,
		endCompaction: vi.fn(),
		updateCompaction: vi.fn(),
		getSystemPrompt: () => "TEST AGENT SYSTEM PROMPT",
	} as unknown as ExtensionContext;

	return {
		agentEnd,
		beforeAgentStart,
		sessionCompact,
		registration,
		ctx,
		sessionManager,
		applyCompaction,
		beginCompaction,
		setMessageRevision: (revision: number) => {
			messageRevision = revision;
		},
	};
}

function createAgentEndEvent(overrides?: Partial<AgentEndEvent>): AgentEndEvent {
	return { type: "agent_end", messages: [], ...overrides };
}

function createBeforeAgentStartEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "next prompt",
		systemPrompt: "TEST AGENT SYSTEM PROMPT",
		systemPromptOptions: { cwd: process.cwd() },
	};
}

function rejectedCompactionEvent(index: number): SessionCompactEvent {
	return {
		type: "session_compact",
		reason: "extension",
		requestId: `rejected-${index}`,
		accepted: false,
		rejectionCause: "would-overflow",
		fromExtension: false,
		willRetry: false,
	} as unknown as SessionCompactEvent;
}

describe("idle-apply (idle generation completes while still idle)", () => {
	it("applies the idle summary during the idle gap, with no prompt in between", async () => {
		const harness = createIdleApplyHarness({});
		const summaryRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				summaryRequested.resolve();
				return fauxAssistantMessage("idle summary applied while the user was away");
			},
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await summaryRequested.promise;
		await settleIdleContinuation();

		expect(harness.registration.state.callCount).toBe(1);
		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);
		const [precomputed, applyOptions] = harness.applyCompaction.mock.calls[0] as [
			{ summary: string; firstKeptEntryId: string },
			{ reason: string; expectedRevision?: number; expectedWarmAnchor?: unknown },
		];
		expect(precomputed.summary).toContain("idle summary applied while the user was away");
		expect(precomputed.firstKeptEntryId).toBeTruthy();
		expect(applyOptions.reason).toBe("extension");
		// The apply must carry a staleness guard: revision when unchanged, warm anchor otherwise.
		expect(applyOptions.expectedRevision ?? applyOptions.expectedWarmAnchor).toBeDefined();
	});

	it("consumes the warm job on the idle apply, so the next prompt never replays it", async () => {
		const harness = createIdleApplyHarness({});
		const summaryRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				summaryRequested.resolve();
				return fauxAssistantMessage("idle summary applied while the user was away");
			},
			() => fauxAssistantMessage("a summary generated for the next prompt"),
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await summaryRequested.promise;
		await settleIdleContinuation();
		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);

		// The stub context never drops below the threshold, so the next prompt
		// still compacts - but it must pay for a fresh summary instead of replaying
		// the already-applied one.
		await harness.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);

		const summaries = harness.applyCompaction.mock.calls.map(
			([precomputed]) => (precomputed as { summary: string }).summary,
		);
		expect(summaries[0]).toContain("idle summary applied while the user was away");
		expect(summaries[1]).toContain("a summary generated for the next prompt");
	});

	it("holds the summary warm when a turn starts before generation completes", async () => {
		const harness = createIdleApplyHarness({});
		const summaryRequested = createDeferred();
		const releaseSummary = createDeferred();
		harness.registration.setResponses([
			async () => {
				summaryRequested.resolve();
				await releaseSummary.promise;
				return fauxAssistantMessage("warm summary the prompt must consume");
			},
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await summaryRequested.promise;

		// A prompt lands while the summary is still generating: no idle apply.
		const blockingRoute = harness.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
		releaseSummary.resolve();
		await blockingRoute;

		// Exactly one apply, and it is the blocking/warm-consume route, not the idle one.
		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);
		expect(harness.beginCompaction).toHaveBeenCalledTimes(1);
		expect(harness.registration.state.callCount).toBe(1);
	});

	it("leaves the warm hold intact when the apply is refused as stale", async () => {
		const harness = createIdleApplyHarness({
			applyCompactionResult: async () => ({ applied: false as const, reason: "stale" as const }),
		});
		const summaryRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				summaryRequested.resolve();
				return fauxAssistantMessage("idle summary that arrives stale");
			},
			() => fauxAssistantMessage("blocking regeneration"),
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await summaryRequested.promise;
		await settleIdleContinuation();

		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);

		// A refused idle apply must not throw and must not destroy the warm hold:
		// the next prompt still offers the same warm summary to the blocking route
		// before falling back to the pre-existing regenerate-on-stale behaviour.
		await harness.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);

		const warmRetryCall = harness.applyCompaction.mock.calls[1] as [{ summary: string }] | undefined;
		expect(warmRetryCall?.[0].summary).toContain("idle summary that arrives stale");
	});

	it("skips the idle apply when the message revision moved under the warm summary", async () => {
		const harness = createIdleApplyHarness({});
		const summaryRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				summaryRequested.resolve();
				return fauxAssistantMessage("idle summary for a rewritten history");
			},
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await summaryRequested.promise;
		// Revision bump plus a rewritten summarized prefix: neither guard can hold.
		harness.setMessageRevision(99);
		harness.sessionManager.appendCompaction(
			"a boundary committed by another route",
			harness.sessionManager.getBranch()[0].id,
			1_000,
		);
		await settleIdleContinuation();

		expect(harness.applyCompaction).not.toHaveBeenCalled();
	});

	it("does not idle-apply when idle compaction is disabled", async () => {
		const harness = createIdleApplyHarness({ idleCompactionEnabled: false });
		harness.registration.setResponses([fauxAssistantMessage("should never be requested")]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await settleIdleContinuation();

		expect(harness.registration.state.callCount).toBe(0);
		expect(harness.applyCompaction).not.toHaveBeenCalled();
	});

	// Three rejected compactions trip the breaker; each rejection also invalidates
	// the in-flight warm job, so the idle continuation must stand down on either
	// guard (breaker tripped, or the observed job is no longer current).
	it("does not idle-apply after failures trip the breaker mid-generation", async () => {
		const harness = createIdleApplyHarness({});
		const summaryRequested = createDeferred();
		const releaseSummary = createDeferred();
		harness.registration.setResponses([
			async () => {
				summaryRequested.resolve();
				await releaseSummary.promise;
				return fauxAssistantMessage("idle summary nobody may apply");
			},
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await summaryRequested.promise;
		for (let index = 0; index < 3; index++) {
			await harness.sessionCompact(rejectedCompactionEvent(index), harness.ctx);
		}
		releaseSummary.resolve();
		await settleIdleContinuation();

		expect(harness.applyCompaction).not.toHaveBeenCalled();
	});

	it("does not idle-apply on a lane the SDK owns", async () => {
		const harness = createIdleApplyHarness({ provider: CLAUDE_SDK_OAUTH_PROVIDER_ID });
		harness.registration.setResponses([fauxAssistantMessage("should never be requested")]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await settleIdleContinuation();

		expect(harness.registration.state.callCount).toBe(0);
		expect(harness.applyCompaction).not.toHaveBeenCalled();
	});
});
