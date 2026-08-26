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

/**
 * Drain the idle-apply continuation chain (generation settles -> guards ->
 * applyCompaction). Without this the assertions run before the continuation
 * scheduled on the warm job's promise has executed.
 */
async function flushIdleApply(): Promise<void> {
	for (let tick = 0; tick < 12; tick++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
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
	// Contract update (idle-apply): the idle warm-up no longer parks its summary
	// until the next prompt. Once generation completes while the session is still
	// idle, the extension applies it immediately, so the [compaction] block
	// renders during the idle gap instead of ahead of the user's next message.
	it("applies the warm compaction at idle once generation completes", async () => {
		const harness = createIdleHarness({});
		const summaryRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				summaryRequested.resolve();
				return fauxAssistantMessage("idle compaction summary");
			},
			// The stub context never drops below the threshold after an apply, so the
			// next prompt still compacts; it must pay for this fresh summary rather
			// than replaying the already-applied idle one.
			() => fauxAssistantMessage("summary generated for the next prompt"),
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await summaryRequested.promise;
		await flushIdleApply();

		expect(harness.registration.state.callCount).toBe(1);
		// The idle apply owns no user-visible feedback operation: it applies a
		// summary it already paid for, exactly like every other extension apply
		// that arrives with a precomputed result.
		expect(harness.beginCompaction).not.toHaveBeenCalled();
		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);
		const [precomputed, applyOptions] = harness.applyCompaction.mock.calls[0] as [
			{ summary: string },
			{ reason: string; expectedRevision?: number },
		];
		expect(precomputed.summary).toContain("idle compaction summary");
		expect(applyOptions).toMatchObject({ reason: "extension", expectedRevision: 1 });

		await harness.beforeAgentStart(
			{
				type: "before_agent_start",
				prompt: "next prompt",
				systemPrompt: "TEST AGENT SYSTEM PROMPT",
				systemPromptOptions: { cwd: process.cwd() },
			},
			harness.ctx,
		);

		// The warm job was consumed by the idle apply, so the idle summary is never
		// applied twice: anything the prompt applies is freshly generated.
		const summaries = harness.applyCompaction.mock.calls.map(([applied]) => (applied as { summary: string }).summary);
		expect(summaries.filter((summary) => summary.includes("idle compaction summary"))).toHaveLength(1);
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

// Upper bound covering IDLE_WARMUP_RETRY_DELAY_MS; the retry must fire within this window.
const RETRY_ADVANCE_MS = 60_000;

function createBeforeAgentStartEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "next prompt",
		systemPrompt: "TEST AGENT SYSTEM PROMPT",
		systemPromptOptions: { cwd: process.cwd() },
	};
}

describe("idle warm-up retry", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a transient idle warm-up failure and applies the retried summary at idle", async () => {
		vi.useFakeTimers();
		const harness = createIdleHarness({});
		const firstRequested = createDeferred();
		const secondRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				firstRequested.resolve();
				return fauxAssistantMessage("summary failure", {
					stopReason: "error",
					errorMessage: "provider overloaded",
				});
			},
			() => {
				secondRequested.resolve();
				return fauxAssistantMessage("warm summary after retry");
			},
			// The stub context stays over the threshold after an apply, so the next
			// prompt compacts again with its own freshly generated summary.
			() => fauxAssistantMessage("summary generated for the next prompt"),
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await firstRequested.promise;
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(RETRY_ADVANCE_MS);
		await secondRequested.promise;
		await vi.advanceTimersByTimeAsync(0);

		// The retried warm-up succeeds while the session is still idle, so it is
		// applied right there instead of waiting for the next prompt.
		expect(harness.registration.state.callCount).toBe(2);
		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);
		const [precomputed, applyOptions] = harness.applyCompaction.mock.calls[0] as [
			{ summary: string },
			{ reason: string; expectedRevision?: number },
		];
		expect(precomputed.summary).toContain("warm summary after retry");
		expect(applyOptions).toMatchObject({ reason: "extension", expectedRevision: 1 });

		await harness.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);

		// Consumed by the idle apply: the retried summary is never applied twice.
		const summaries = harness.applyCompaction.mock.calls.map(([applied]) => (applied as { summary: string }).summary);
		expect(summaries.filter((summary) => summary.includes("warm summary after retry"))).toHaveLength(1);
	});

	it("cancels the pending idle retry when a prompt arrives first", async () => {
		vi.useFakeTimers();
		const harness = createIdleHarness({});
		const firstRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				firstRequested.resolve();
				return fauxAssistantMessage("summary failure", {
					stopReason: "error",
					errorMessage: "provider overloaded",
				});
			},
			() => fauxAssistantMessage("should never be requested"),
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await firstRequested.promise;
		await vi.advanceTimersByTimeAsync(0);

		await harness.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
		const callsAfterPrompt = harness.registration.state.callCount;

		await vi.advanceTimersByTimeAsync(RETRY_ADVANCE_MS * 3);

		expect(harness.registration.state.callCount).toBe(callsAfterPrompt);
	});

	it("does not retry a non-transient idle warm-up failure", async () => {
		vi.useFakeTimers();
		const harness = createIdleHarness({});
		const firstRequested = createDeferred();
		harness.registration.setResponses([
			() => {
				firstRequested.resolve();
				return fauxAssistantMessage("summary failure", {
					stopReason: "error",
					errorMessage: "summarization request rejected: invalid schema",
				});
			},
			() => fauxAssistantMessage("should never be requested"),
		]);

		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await firstRequested.promise;
		await vi.advanceTimersByTimeAsync(RETRY_ADVANCE_MS * 3);

		expect(harness.registration.state.callCount).toBe(1);
	});
});
