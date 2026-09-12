import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type { OpenAiRemoteCompactionDependencies } from "../../src/core/extensions/builtin/compaction/openai-remote.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "../../src/core/extensions/index.ts";
import type { SessionEntry, SessionMessageEntry } from "../../src/core/session-manager.ts";
import { createInMemoryExtensionSessionSettings } from "../helpers/extension-session-settings.ts";
import { OPENAI_NATIVE_LEGACY_MODEL } from "./openai-remote-test-models.ts";

function messageEntry(id: string, parentId: string | null, message: SessionMessageEntry["message"]): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(1_775_000_000_000 + id.length).toISOString(),
		message,
	};
}

function openAiBranch(assistantText = "I will inspect it."): SessionEntry[] {
	return [
		{
			type: "model_change",
			id: "model",
			parentId: null,
			timestamp: new Date(1_775_000_000_000).toISOString(),
			provider: "openai",
			modelId: "gpt-5.4",
		},
		messageEntry("u1", "model", {
			role: "user",
			content: [{ type: "text", text: "Please inspect the build." }],
			timestamp: 1,
		}),
		messageEntry("a1", "u1", {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			content: [
				{
					type: "text",
					text: assistantText,
					textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
				},
				{ type: "toolCall", id: "call_build|fc_build", name: "bash", arguments: { cmd: "npm test" } },
			],
			usage: {
				input: 9_000,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 9_020,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		}),
		messageEntry("t1", "a1", {
			role: "toolResult",
			toolCallId: "call_build|fc_build",
			toolName: "bash",
			content: [{ type: "text", text: "Tests passed." }],
			isError: false,
			timestamp: 3,
		}),
		messageEntry("u2", "t1", {
			role: "user",
			content: [{ type: "text", text: "Great. Commit it." }],
			timestamp: 4,
		}),
	];
}

function compactionEvent(branchEntries: SessionEntry[], signal: AbortSignal): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: true,
		requestId: "remote-abort-request",
		preparation: {
			firstKeptEntryId: "u2",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 9_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		branchEntries,
		signal,
	};
}

interface RemoteAbortHarness {
	sessionBeforeCompact: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>;
	beforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
	ctx: ExtensionContext;
	endCompaction: ReturnType<typeof vi.fn>;
	fetchCalls: number;
}

function createRemoteAbortHarness(options?: {
	branch?: SessionEntry[];
	usageTokens?: number;
	contextWindow?: number;
	beginCompaction?: () => AbortSignal | undefined;
	fetch?: OpenAiRemoteCompactionDependencies["fetch"];
}): RemoteAbortHarness {
	const branch = options?.branch ?? openAiBranch();
	let sessionBeforeCompact: RemoteAbortHarness["sessionBeforeCompact"] | undefined;
	let beforeAgentStart: RemoteAbortHarness["beforeAgentStart"] | undefined;
	const harness: { fetchCalls: number } = { fetchCalls: 0 };
	const fetchImpl: OpenAiRemoteCompactionDependencies["fetch"] =
		options?.fetch ??
		(async () => {
			harness.fetchCalls += 1;
			throw new Error("fetch must not be reached in this scenario");
		});
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "session_before_compact") {
				sessionBeforeCompact = handler as RemoteAbortHarness["sessionBeforeCompact"];
			}
			if (event === "before_agent_start") {
				beforeAgentStart = handler as RemoteAbortHarness["beforeAgentStart"];
			}
		},
		appendEntry: vi.fn(),
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "off" as const,
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	}) as ExtensionAPI;
	compactionExtension(api, {
		fetch: (input, init) => {
			harness.fetchCalls += 1;
			return fetchImpl(input, init);
		},
	});
	if (!sessionBeforeCompact) throw new Error("session_before_compact handler was not registered");
	if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");

	const endCompaction = vi.fn();
	const modelRegistry = Object.assign(Object.create(null), {
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
	}) as ExtensionContext["modelRegistry"];
	const contextWindow = options?.contextWindow ?? 10_000;
	const usageTokens = options?.usageTokens ?? 9_950;
	const ctx = {
		hasUI: false,
		mode: "print",
		ui: Object.assign(Object.create(null), { notify: vi.fn() }) as ExtensionContext["ui"],
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => branch,
			getBranch: () => branch,
			getSessionId: () => "remote-abort-session",
		} as unknown as ExtensionContext["sessionManager"],
		modelRegistry,
		model: OPENAI_NATIVE_LEGACY_MODEL,
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
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 1 }),
		getLookAtSettings: () => ({ enabled: true, models: undefined }),
		getImageSettings: () => ({ autoResize: true, blockImages: false }),
		sessionSettings: createInMemoryExtensionSessionSettings(),
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction: vi.fn(async () => ({ applied: true as const, reason: "ok" as const })),
		beginCompaction: options?.beginCompaction ?? (() => undefined),
		endCompaction,
		getSystemPrompt: () => "TEST AGENT SYSTEM PROMPT",
	} as unknown as ExtensionContext;

	return { sessionBeforeCompact, beforeAgentStart, ctx, endCompaction, fetchCalls: harness.fetchCalls };
}

describe("OpenAI remote compaction abort stand-down", () => {
	it("resolves without a compaction when the core-route signal is already aborted", async () => {
		// Given: the admission compaction was superseded (its controller aborted)
		// before the session_before_compact handler ran — the exact production
		// interleaving from the resumed-session report (issue #886).
		const harness = createRemoteAbortHarness();
		const controller = new AbortController();
		controller.abort();

		// When / Then: the handler must stand down silently instead of leaking a
		// raw "Request was aborted" throw through ExtensionRunner.emit.
		await expect(
			harness.sessionBeforeCompact(compactionEvent(openAiBranch(), controller.signal), harness.ctx),
		).resolves.toBeUndefined();
	});

	it("resolves without a compaction when the signal aborts during the remote request", async () => {
		// Given: the remote compact request is in flight when a superseding
		// admission aborts the compaction signal.
		const controller = new AbortController();
		const fetchStarted = Promise.withResolvers<void>();
		const harness = createRemoteAbortHarness({
			fetch: (_input, init) =>
				new Promise((_resolve, reject) => {
					fetchStarted.resolve();
					const signal = init?.signal;
					if (!signal) {
						reject(new Error("expected an abortable remote request"));
						return;
					}
					signal.addEventListener(
						"abort",
						() => reject(new DOMException("The operation was aborted.", "AbortError")),
						{ once: true },
					);
				}),
		});

		const handlerResult = harness.sessionBeforeCompact(
			compactionEvent(openAiBranch(), controller.signal),
			harness.ctx,
		);
		await fetchStarted.promise;

		// When
		controller.abort();

		// Then
		await expect(handlerResult).resolves.toBeUndefined();
	});

	it("degrades the blocking route silently when the feedback signal is aborted", async () => {
		// Given: an aborted feedback signal on the blocking route with a remote
		// compaction model. The faux-model flavor of this contract is already
		// pinned by blocking-compaction-review-hardening.test.ts ("degrades
		// silently with no error message"); the remote flavor must match it.
		const controller = new AbortController();
		controller.abort();
		const harness = createRemoteAbortHarness({
			branch: openAiBranch("Inspect output line. ".repeat(2_000)),
			beginCompaction: () => controller.signal,
		});

		// When / Then
		await expect(
			harness.beforeAgentStart(
				{ type: "before_agent_start", systemPrompt: "", preamble: undefined } as unknown as BeforeAgentStartEvent,
				harness.ctx,
			),
		).resolves.toBeUndefined();
		const errorMessages = harness.endCompaction.mock.calls
			.map((call) => (call as [{ errorMessage?: string }])[0]?.errorMessage)
			.filter((message): message is string => typeof message === "string");
		expect(errorMessages).toHaveLength(0);
	});
});
