/**
 * Warm summary reuse (senpi#5481): a speculative warm summary is kept while its summarized prefix
 * is intact. Growth after its anchor neither aborts a running generation nor discards a finished
 * one; a finished candidate is applied as-is while `summary + tail` fits `threshold - lead`, and is
 * otherwise regenerated from its own summary plus only the entries after its anchor.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import { flushCompactionLogs } from "../../src/core/extensions/builtin/compaction/log.ts";
import { resolveCompactionGeometry } from "../../src/core/extensions/builtin/compaction/orchestration.ts";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "../../src/core/extensions/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTempAgentDir } from "../support/temp-agent-dir.ts";

const CONTEXT_WINDOW = 100_000;
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

async function settle(): Promise<void> {
	for (let tick = 0; tick < 12; tick++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

interface Harness {
	registration: FauxProviderRegistration;
	ctx: ExtensionContext;
	sessionManager: SessionManager;
	applyCompaction: ReturnType<typeof vi.fn>;
	agentEnd: () => Promise<void>;
	beforeAgentStart: () => Promise<unknown>;
	agentSettled: () => Promise<void>;
	setUsage: (tokens: number) => void;
	setIdle: (idle: boolean) => void;
	thresholdTokens: number;
	floorTokens: number;
	logEvents: () => Promise<Array<{ event: string; reason?: string }>>;
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

	let onAgentEnd: ((event: AgentEndEvent, ctx: ExtensionContext) => unknown) | undefined;
	let onBeforeAgentStart: ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown) | undefined;
	let onAgentSettled: ((event: { type: "agent_settled" }, ctx: ExtensionContext) => unknown) | undefined;
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "agent_end") onAgentEnd = handler as typeof onAgentEnd;
			if (event === "before_agent_start") onBeforeAgentStart = handler as typeof onBeforeAgentStart;
			if (event === "agent_settled") onAgentSettled = handler as typeof onAgentSettled;
		},
		appendEntry: vi.fn(),
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "off" as const,
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	}) as ExtensionAPI;
	compactionExtension(api);
	if (!onAgentEnd || !onBeforeAgentStart || !onAgentSettled)
		throw new Error("compaction handlers were not registered");

	// keepRecentTokens: 1 keeps only the newest entry, so each cut point is predictable.
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1, speculativeCooldownMs: 0 };
	const geometry = resolveCompactionGeometry({ contextWindow: CONTEXT_WINDOW, settings });
	let usageTokens = 0;
	let idle = true;
	const agentDir = createTempAgentDir("senpi-warm-reuse-");
	const applyCompaction = vi.fn(async () => ({ applied: true as const, reason: "ok" as const }));
	const ctx = {
		hasUI: false,
		mode: "tui",
		ui: Object.assign(Object.create(null), { notify: vi.fn() }),
		cwd: process.cwd(),
		agentDir,
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry,
		model,
		serviceTier: undefined,
		isIdle: () => idle,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens: usageTokens, contextWindow: CONTEXT_WINDOW, percent: 0 }),
		getCompactionSettings: () => settings,
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction,
		beginCompaction: vi.fn(() => undefined),
		endCompaction: vi.fn(),
		updateCompaction: vi.fn(),
		getSystemPrompt: () => "TEST AGENT SYSTEM PROMPT",
	} as unknown as ExtensionContext;

	const agentEnd = onAgentEnd;
	const beforeAgentStart = onBeforeAgentStart;
	const agentSettled = onAgentSettled;
	return {
		registration,
		ctx,
		sessionManager,
		applyCompaction,
		agentEnd: async () => {
			await agentEnd({ type: "agent_end", messages: [] }, ctx);
		},
		beforeAgentStart: async () =>
			await beforeAgentStart(
				{
					type: "before_agent_start",
					trigger: "prompt",
					prompt: "next prompt",
					systemPrompt: "TEST AGENT SYSTEM PROMPT",
					systemPromptOptions: { cwd: process.cwd() },
				},
				ctx,
			),
		agentSettled: async () => {
			await agentSettled({ type: "agent_settled" }, ctx);
		},
		setUsage: (tokens: number) => {
			usageTokens = tokens;
		},
		setIdle: (next: boolean) => {
			idle = next;
		},
		thresholdTokens: geometry.thresholdTokens,
		floorTokens: Math.ceil(CONTEXT_WINDOW * 0.5),
		logEvents: async () => {
			await flushCompactionLogs();
			return readFileSync(join(agentDir, "logs", "compaction.log"), "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as { event: string; reason?: string });
		},
	};
}

function appendOversizedTail(sessionManager: SessionManager): void {
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: `large tool output ${"x".repeat(240_000)}` }],
		timestamp: Date.now(),
	});
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "after large" }],
		timestamp: Date.now(),
	});
}

describe("warm summary reuse (senpi#5481)", () => {
	it("keeps an in-flight warm generation running when the session grows past keepRecentTokens", async () => {
		const harness = createHarness();
		const start = harness.floorTokens + 200;
		const grown = start + 8_192 + 300;
		expect(grown).toBeLessThan(harness.thresholdTokens);
		const requested = createDeferred();
		const release = createDeferred();
		let firstSignal: AbortSignal | undefined;
		harness.registration.setResponses([
			async (_context, options) => {
				firstSignal = options?.signal;
				requested.resolve();
				await release.promise;
				return fauxAssistantMessage("first warm summary");
			},
			() => fauxAssistantMessage("a replacement that must not be requested"),
		]);

		harness.setUsage(start);
		await harness.agentEnd();
		await requested.promise;
		harness.setUsage(grown);
		await harness.agentEnd();
		await settle();

		expect(harness.registration.state.callCount).toBe(1);
		expect(firstSignal?.aborted).toBe(false);
		release.resolve();
		await settle();
	});

	it("keeps a finished candidate that still fits instead of regenerating it", async () => {
		const harness = createHarness();
		const start = harness.floorTokens + 200;
		harness.registration.setResponses([
			() => fauxAssistantMessage("finished warm summary"),
			() => fauxAssistantMessage("a regeneration that must not be requested"),
		]);

		harness.setUsage(start);
		await harness.agentEnd();
		await settle();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "small growth" }],
			timestamp: Date.now(),
		});
		harness.setUsage(start + 8_192 + 300);
		await harness.agentEnd();
		await settle();

		expect(harness.registration.state.callCount).toBe(1);
		const events = await harness.logEvents();
		expect(events.some((entry) => entry.event === "speculative_reused")).toBe(true);
	});

	it("applies a finished candidate that was kept across turns once the session settles above the threshold", async () => {
		const harness = createHarness();
		harness.registration.setResponses([
			() => fauxAssistantMessage("KEPT warm summary"),
			() => fauxAssistantMessage("a second summary that must not be requested"),
		]);

		harness.setUsage(harness.floorTokens + 200);
		await harness.agentEnd();
		await settle();
		harness.setUsage(harness.thresholdTokens + 500);
		harness.setIdle(false);
		await harness.agentEnd();
		await settle();
		expect(harness.applyCompaction).not.toHaveBeenCalled();
		harness.setIdle(true);
		await harness.agentSettled();
		await settle();

		expect(harness.registration.state.callCount).toBe(1);
		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);
		const [applied] = harness.applyCompaction.mock.calls[0] as unknown as [{ summary: string }];
		expect(applied.summary).toContain("KEPT warm summary");
		const events = await harness.logEvents();
		expect(events).toContainEqual(expect.objectContaining({ event: "idle_applied" }));
	});

	it("regenerates an unfit finished candidate once per lineage, not on every turn", async () => {
		const harness = createHarness();
		const start = harness.floorTokens + 200;
		harness.registration.setResponses([
			() => fauxAssistantMessage("SUMMARY-ONE of the seed conversation"),
			() => fauxAssistantMessage("SUMMARY-TWO after the large output"),
			() => fauxAssistantMessage("a third summary that must not be requested"),
		]);

		harness.setUsage(start);
		await harness.agentEnd();
		await settle();
		appendOversizedTail(harness.sessionManager);
		harness.setUsage(start + 8_192 + 300);
		await harness.agentEnd();
		await settle();

		expect(harness.registration.state.callCount).toBe(2);
		appendOversizedTail(harness.sessionManager);
		harness.setUsage(start + 2 * (8_192 + 300));
		await harness.agentEnd();
		await settle();

		expect(harness.registration.state.callCount).toBe(2);
		const events = await harness.logEvents();
		expect(events).toContainEqual(
			expect.objectContaining({ event: "speculative_regenerated", reason: "tail-over-budget" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ event: "speculative_reused", reason: "regeneration-cap" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ event: "idle_apply_skipped", reason: "below-threshold" }),
		);
	});

	it("replaces an in-flight warm generation whose summarized prefix was rewritten", async () => {
		const harness = createHarness();
		const start = harness.floorTokens + 200;
		const requested = createDeferred();
		const release = createDeferred();
		let firstSignal: AbortSignal | undefined;
		harness.registration.setResponses([
			async (_context, options) => {
				firstSignal = options?.signal;
				requested.resolve();
				await release.promise;
				return fauxAssistantMessage("summary of a prefix that no longer exists");
			},
			() => fauxAssistantMessage("summary of the rewritten branch"),
		]);

		harness.setUsage(start);
		await harness.agentEnd();
		await requested.promise;
		const keptEntry = harness.sessionManager.getBranch().at(-1);
		if (!keptEntry) throw new Error("expected a kept entry");
		harness.sessionManager.appendCompaction("a boundary that landed while the summary ran", keptEntry.id, 1_000);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after the boundary" }],
			timestamp: Date.now(),
		});
		await harness.agentEnd();
		await settle();

		expect(firstSignal?.aborted).toBe(true);
		expect(harness.registration.state.callCount).toBe(2);
		release.resolve();
		await settle();
	});

	it("does not make the threshold route wait on a warm generation whose prefix was rewritten", async () => {
		const harness = createHarness();
		const start = harness.floorTokens + 200;
		const requested = createDeferred();
		const release = createDeferred();
		harness.registration.setResponses([
			async () => {
				requested.resolve();
				await release.promise;
				return fauxAssistantMessage("summary of a prefix that no longer exists");
			},
			() => fauxAssistantMessage("FRESH summary at the threshold"),
		]);

		harness.setUsage(start);
		await harness.agentEnd();
		await requested.promise;
		const keptEntry = harness.sessionManager.getBranch().at(-1);
		if (!keptEntry) throw new Error("expected a kept entry");
		harness.sessionManager.appendCompaction("a boundary that landed while the summary ran", keptEntry.id, 1_000);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after the boundary" }],
			timestamp: Date.now(),
		});
		harness.setUsage(harness.thresholdTokens + 500);
		await harness.beforeAgentStart();

		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);
		const [applied] = harness.applyCompaction.mock.calls[0] as unknown as [{ summary: string }];
		expect(applied.summary).toContain("FRESH summary at the threshold");
		release.resolve();
		await settle();
	}, 15_000);
});
