import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryExtensionSessionSettings } from "../helpers/extension-session-settings.ts";

// An OpenAI Responses model that qualifies for the remote-compaction route.
const OPENAI_REMOTE_MODEL = {
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
} as unknown as Model<"openai-responses">;

function createBeforeAgentStartEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "continue",
		systemPrompt: "system",
		systemPromptOptions: Object.create(null) as BeforeAgentStartEvent["systemPromptOptions"],
	};
}

function createOpenAiHarness(options: { usageTokens: number }) {
	const endCompaction = vi.fn();
	const sessionManager = SessionManager.inMemory();
	// Enough content for prepareCompaction to produce a snapshot so the remote
	// stage runs and times out; the local fallback then reports "unavailable"
	// because applyCompaction is stubbed to decline.
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Summarize old context" }],
		timestamp: 1,
	});
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Old assistant context ".repeat(6_000) }],
		api: "openai-responses",
		provider: "openai",
		model: OPENAI_REMOTE_MODEL.id,
		usage: {
			input: 30_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Keep latest request" }],
		timestamp: 3,
	});
	const modelRegistry = Object.create(null) as ExtensionContext["modelRegistry"];
	// No usable credential: the remote stage reports its fallback with this reason and
	// the local summarization throws SummaryGenerationError("auth"), which the blocking
	// route catches and degrades to "unavailable" — both ends of the threaded message.
	modelRegistry.getApiKeyAndHeaders = (async () => ({ ok: false as const, error: "no API key configured" })) as never;
	const usageTokens = options.usageTokens;
	const ctx = {
		hasUI: false,
		mode: "print",
		ui: { notify: () => undefined } as unknown as ExtensionContext["ui"],
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry,
		model: OPENAI_REMOTE_MODEL,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({
			tokens: usageTokens,
			contextWindow: 10_000,
			percent: (usageTokens / 10_000) * 100,
		}),
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 2_000 }),
		getLookAtSettings: () => ({ enabled: true, models: undefined }),
		getImageSettings: () => ({ autoResize: true, blockImages: false }),
		sessionSettings: createInMemoryExtensionSessionSettings(),
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction: vi.fn(async () => ({ applied: false as const, reason: "unavailable" as const })),
		beginCompaction: () => undefined,
		endCompaction,
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	return { ctx, endCompaction };
}

describe("compaction failure reason surfacing (issue #765)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces the remote fallback reason and the local reason instead of the generic message", async () => {
		let beforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, unknown> | undefined;
		// A fetch that never resolves, so the remote stage aborts on its timeout.
		const timeoutFetch = vi.fn(
			(_url: unknown, init?: { signal?: AbortSignal }) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
				}),
		);
		const api = {
			events: { emit: () => undefined },
			on: (event: string, handler: unknown) => {
				if (event === "before_agent_start") {
					beforeAgentStart = handler as ExtensionHandler<BeforeAgentStartEvent, unknown>;
				}
			},
		} as unknown as ExtensionAPI;
		compactionExtension(api, { fetch: timeoutFetch as never, remoteTimeoutMs: 1 });
		expect(beforeAgentStart).toBeDefined();

		const harness = createOpenAiHarness({ usageTokens: 9_950 });
		await beforeAgentStart?.(createBeforeAgentStartEvent() as never, harness.ctx);

		const calls = harness.endCompaction.mock.calls.map((call) => call[0] as { errorMessage?: string });
		const withReason = calls.find((call) => typeof call.errorMessage === "string");
		// The remote stage's fallback reason and the terminal local reason are both
		// surfaced, joined into one diagnosable message instead of the bare generic one.
		expect(withReason?.errorMessage).toBe(
			"Compaction did not apply: no API key configured; local fallback unavailable",
		);
	});
});
