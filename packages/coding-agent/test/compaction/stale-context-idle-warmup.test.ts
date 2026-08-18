import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
} from "../../src/core/extensions/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Reproduction for the field crash
 *
 *   pi exiting due to uncaughtException:
 *   Error: stale extension generation after reload
 *       at ExtensionRunner.assertActive (core/extensions/runner.js)
 *       at Object.getContextUsage (core/extensions/runner.js)
 *       at core/extensions/builtin/compaction/index.js
 *
 * `armIdleWarmupRetry` captures an `ExtensionContext` and reuses it from two
 * continuations that outlive the runner generation that produced it:
 *
 *  1. `job.failure.then(...)` reads `ctx.getContextUsage()`, and
 *  2. the armed `setTimeout` reads `ctx.isIdle()` and starts a new warm-up.
 *
 * `AgentSession.reload()` invalidates the OLD runner
 * (agent-session.ts: `oldExtensionRunner.invalidate("stale extension
 * generation after reload")`), after which every context getter throws. The
 * failure continuation is spawned with `void`, so the throw becomes an
 * unhandled rejection; the timer callback throws straight into the timer
 * queue, which is a genuine uncaughtException that kills the process.
 */

type Registration = FauxProviderRegistration;
const registrations: Registration[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const registration of registrations.splice(0)) registration.unregister();
});

const RETRY_ADVANCE_MS = 60_000;

interface StaleContextHarness {
	agentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;
	sessionShutdown: ((event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	registration: Registration;
	ctx: ExtensionContext;
	/** Mirrors `ExtensionRunner.invalidate()`: every later context read throws. */
	invalidateRunnerGeneration: () => void;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("deferred resolver was not initialized");
	return { promise, resolve };
}

/**
 * Builds the compaction extension over a context whose getters are guarded by
 * the same stale-generation check the real `ExtensionRunner` applies
 * (runner.ts `assertActive()`), so invalidation reproduces production exactly.
 */
function createStaleContextHarness(): StaleContextHarness {
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

	let agentEnd: StaleContextHarness["agentEnd"] | undefined;
	let sessionShutdown: StaleContextHarness["sessionShutdown"];
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "agent_end") agentEnd = handler as StaleContextHarness["agentEnd"];
			if (event === "session_shutdown") sessionShutdown = handler as StaleContextHarness["sessionShutdown"];
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

	const contextWindow = 100_000;
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };

	// Exactly the message AgentSession.reload() passes to invalidate().
	const STALE_MESSAGE = "stale extension generation after reload";
	let staleMessage: string | undefined;
	const assertActive = (): void => {
		if (staleMessage) throw new Error(staleMessage);
	};

	const ctx = {
		mode: "tui" as const,
		model,
		modelRegistry,
		sessionManager,
		agentDir: undefined,
		get isIdle() {
			assertActive();
			return () => true;
		},
		get getContextUsage() {
			assertActive();
			return () => ({ tokens: 80_000, contextWindow, percent: 80 });
		},
		get getCompactionSettings() {
			assertActive();
			return () => settings;
		},
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction: vi.fn(async () => ({ applied: true, reason: "ok" })),
		beginCompaction: vi.fn(() => undefined),
		endCompaction: vi.fn(),
		updateCompaction: vi.fn(),
		getSystemPrompt: () => "TEST AGENT SYSTEM PROMPT",
	} as unknown as ExtensionContext;

	return {
		agentEnd,
		sessionShutdown,
		registration,
		ctx,
		invalidateRunnerGeneration: () => {
			staleMessage = STALE_MESSAGE;
		},
	};
}

function createAgentEndEvent(overrides?: Partial<AgentEndEvent>): AgentEndEvent {
	return { type: "agent_end", messages: [], ...overrides };
}

/** Fails the test if the process observes an unhandled rejection. */
function trackUnhandledRejections(): { errors: unknown[]; stop: () => void } {
	const errors: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		errors.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	return { errors, stop: () => process.off("unhandledRejection", onUnhandled) };
}

describe("Given a reload invalidates the runner while an idle warm-up retry is pending", () => {
	it("Then the failure continuation must not throw a stale-generation error", async () => {
		const harness = createStaleContextHarness();
		const tracker = trackUnhandledRejections();
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

		// Given: an idle warm-up job is in flight and about to fail transiently.
		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await firstRequested.promise;

		// When: a session reload retires this extension generation before the
		// warm-up failure continuation runs.
		harness.invalidateRunnerGeneration();

		// Then: draining the continuation must not raise the stale-generation
		// error the field crash reported.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		tracker.stop();

		const staleErrors = tracker.errors.filter(
			(error) => error instanceof Error && error.message.includes("stale extension generation"),
		);
		expect(staleErrors).toEqual([]);
	});

	it("Then the armed retry timer must not fire a stale-generation error", async () => {
		vi.useFakeTimers();
		const harness = createStaleContextHarness();
		const tracker = trackUnhandledRejections();
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

		// Given: the transient warm-up failure has armed the retry timer.
		await harness.agentEnd(createAgentEndEvent(), harness.ctx);
		await firstRequested.promise;
		await vi.advanceTimersByTimeAsync(0);
		const callsBeforeReload = harness.registration.state.callCount;

		// When: the reload retires this generation and the timer then fires.
		harness.invalidateRunnerGeneration();

		// Then: the timer callback is a no-op instead of an uncaughtException,
		// and it must not start another warm-up on the dead generation. A throw
		// inside the timer callback surfaces here as a rejection, so capturing it
		// is what distinguishes the fixed watcher from the crashing one.
		let timerError: unknown;
		try {
			await vi.advanceTimersByTimeAsync(RETRY_ADVANCE_MS);
		} catch (error) {
			timerError = error;
		}
		tracker.stop();
		expect(timerError).toBeUndefined();

		const staleErrors = tracker.errors.filter(
			(error) => error instanceof Error && error.message.includes("stale extension generation"),
		);
		expect(staleErrors).toEqual([]);
		expect(harness.registration.state.callCount).toBe(callsBeforeReload);
	});
});
