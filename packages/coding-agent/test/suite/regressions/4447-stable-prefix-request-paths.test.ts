import { randomUUID } from "node:crypto";
import {
	type Context,
	fauxAssistantMessage,
	getInitialSystemMessage,
	getSystemMessageText,
	type Model,
	normalizeContext,
	type SystemMessage,
	type TranscriptContext,
	type WarmPromptCacheResult,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicSystemTextBlocks } from "../../../../ai/src/api/anthropic-system-blocks.ts";
import { prepareCompaction } from "../../../src/core/compaction/index.ts";
import btwExtension from "../../../src/core/extensions/builtin/btw/index.ts";
import { createCacheKeepAliveExtension } from "../../../src/core/extensions/builtin/cache-keepalive/index.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionBeforeCompactEvent,
} from "../../../src/core/extensions/types.ts";
import {
	createBeforeAgentStartEvent,
	createBlockingContext,
	createCompactionHandlers,
} from "../../helpers/blocking-compaction-harness.ts";
import { createHarness, type Harness } from "../harness.ts";

const STABLE = "You are a coding agent.\n\n# Rules\nKeep diffs small.";
const PROMPT = `${STABLE}\n\n<memory-block>revision 7</memory-block>`;
const CACHE = { type: "ephemeral" } as const;
const ANTHROPIC_MODEL: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

const memoryExtension: ExtensionFactory = (pi) => {
	pi.on(
		"before_agent_start",
		(event) => ({ systemPrompt: `${event.systemPrompt}\n\n<memory-block>revision 7</memory-block>` }),
		{ previewSafe: true },
	);
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

interface SentSystem {
	readonly leading: SystemMessage | undefined;
	readonly turnStablePrefix: string;
}

function leadingOf(context: Context | TranscriptContext): SystemMessage | undefined {
	const transcript = "systemPrompt" in context || "tools" in context ? normalizeContext(context) : context;
	return getInitialSystemMessage(transcript.messages);
}

async function sessionWithTurn(): Promise<{ harness: Harness; turnStablePrefix: string; turn: SystemMessage }> {
	const harness = await createHarness({
		extensionFactories: [memoryExtension, btwExtension],
		settings: { compaction: { keepRecentTokens: 1 } },
	});
	cleanups.push(() => harness.cleanup());
	let turn: SystemMessage | undefined;
	harness.setResponses([
		(context) => {
			turn = getInitialSystemMessage(context.messages);
			return fauxAssistantMessage("first answer ".repeat(200));
		},
		fauxAssistantMessage("second answer ".repeat(200)),
	]);
	await harness.session.prompt("first question ".repeat(200));
	await harness.session.prompt("second question ".repeat(200));
	const turnStablePrefix = harness.session.agent.state.systemPromptStablePrefix;
	if (turn === undefined || turnStablePrefix === undefined) throw new Error("turn request carried no stable prefix");
	return { harness, turnStablePrefix, turn };
}

/** Captures every request; returns the first one built from the agent's own system prompt. */
function captureAgentPromptRequest(harness: Harness, turnStablePrefix: string): () => SystemMessage | undefined {
	const sent: SystemMessage[] = [];
	const respond = (context: TranscriptContext) => {
		const leading = getInitialSystemMessage(context.messages);
		if (leading !== undefined) sent.push(leading);
		return fauxAssistantMessage("summary or side answer");
	};
	harness.setResponses([respond, respond, respond, respond]);
	return () => sent.find((leading) => getSystemMessageText(leading).startsWith(turnStablePrefix));
}

function blockingCtx(harness: ReturnType<typeof createBlockingContext>): ExtensionContext {
	return { ...harness.ctx, getSystemPrompt: () => PROMPT, getSystemPromptStablePrefix: () => STABLE };
}

function captureFaux(harness: ReturnType<typeof createBlockingContext>): () => SystemMessage | undefined {
	let sent: SystemMessage | undefined;
	harness.registration.setResponses([
		(context) => {
			sent = getInitialSystemMessage(context.messages);
			return fauxAssistantMessage("summary");
		},
	]);
	return () => sent;
}

function coreCompactEvent(harness: ReturnType<typeof createBlockingContext>): SessionBeforeCompactEvent {
	const branchEntries = harness.sessionManager.getBranch();
	const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings());
	if (!preparation) throw new Error("fixture is not compactable");
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: false,
		requestId: randomUUID(),
		preparation,
		branchEntries,
		signal: new AbortController().signal,
	};
}

const REQUEST_PATHS: ReadonlyArray<readonly [string, () => Promise<SentSystem>]> = [
	[
		"turn request",
		async () => {
			const { turn, turnStablePrefix } = await sessionWithTurn();
			return { leading: turn, turnStablePrefix };
		},
	],
	[
		"prompt-cache prewarm prefix request",
		async () => {
			const { harness, turnStablePrefix } = await sessionWithTurn();
			const result = await harness.getExtensionRunner().createContext().getPromptCachePrefixRequest?.();
			if (result?.status !== "ready") throw new Error(`prewarm skipped: ${JSON.stringify(result)}`);
			return { leading: leadingOf(result.request.context), turnStablePrefix };
		},
	],
	[
		"/btw side query",
		async () => {
			const { harness, turnStablePrefix } = await sessionWithTurn();
			const sent = captureAgentPromptRequest(harness, turnStablePrefix);
			await harness.session.prompt("/btw what did we discuss?");
			return { leading: sent(), turnStablePrefix };
		},
	],
	[
		"experimental cache-friendly compaction",
		async () => {
			const previous = process.env.SENPI_EXPERIMENTAL;
			process.env.SENPI_EXPERIMENTAL = "1";
			cleanups.push(() => {
				if (previous === undefined) delete process.env.SENPI_EXPERIMENTAL;
				else process.env.SENPI_EXPERIMENTAL = previous;
			});
			const { harness, turnStablePrefix } = await sessionWithTurn();
			const sent = captureAgentPromptRequest(harness, turnStablePrefix);
			await harness.session.compact();
			return { leading: sent(), turnStablePrefix };
		},
	],
	[
		"speculative compaction summary",
		async () => {
			const handlers = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 4_000 });
			cleanups.push(() => harness.registration.unregister());
			const sent = captureFaux(harness);
			await handlers.beforeAgentStart(createBeforeAgentStartEvent(), blockingCtx(harness));
			await handlers.waitForSpeculativeJob();
			return { leading: sent(), turnStablePrefix: STABLE };
		},
	],
	[
		"core-route compaction summary",
		async () => {
			const handlers = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_500 });
			cleanups.push(() => harness.registration.unregister());
			const sent = captureFaux(harness);
			await handlers.sessionBeforeCompact(coreCompactEvent(harness), blockingCtx(harness));
			return { leading: sent(), turnStablePrefix: STABLE };
		},
	],
	[
		"cache keep-alive ping",
		async () => {
			vi.useFakeTimers();
			cleanups.push(() => vi.useRealTimers());
			let warmed: Context | undefined;
			const warm = vi.fn(async (_model: unknown, context: Context): Promise<WarmPromptCacheResult> => {
				warmed = context;
				return { supported: true, usage: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0 }, usageRaw: {} };
			});
			const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
			const pi = {
				on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
					handlers.set(event, [...(handlers.get(event) ?? []), handler]),
				appendEntry: vi.fn(),
				registerEntryRenderer: vi.fn(),
				getActiveTools: () => [],
				getAllTools: () => [],
				events: { emit: vi.fn(), on: () => () => {} },
			} as unknown as ExtensionAPI;
			createCacheKeepAliveExtension({ warmPromptCache: warm })(pi);
			const ctx = {
				model: ANTHROPIC_MODEL,
				isIdle: () => true,
				hasPendingMessages: () => false,
				getPromptCacheSafeWaitSeconds: () => 300,
				getPromptCacheKeepAliveSettings: () => ({
					enabled: true,
					maxRequestsPerSession: 3,
					maxCostUsdPerSession: 1,
					marginSeconds: 60,
				}),
				getSystemPrompt: () => PROMPT,
				getSystemPromptStablePrefix: () => STABLE,
				prepareProviderRequest: async (messages: unknown[]) => ({
					messages,
					transformPayload: async (payload: unknown) => payload,
					transformHeaders: async (headers: unknown) => headers,
				}),
				modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) },
				sessionManager: { getSessionId: () => "session-1", buildSessionContext: () => ({ messages: [] }) },
				ui: { notify: vi.fn() },
			} as unknown as ExtensionContext;
			const agentEnd = {
				type: "agent_end",
				messages: [
					{ role: "user", content: "hello", timestamp: 1 },
					{
						...fauxAssistantMessage("done"),
						api: "anthropic-messages",
						provider: "anthropic",
						usage: {
							input: 5_000,
							output: 10,
							cacheRead: 40_000,
							cacheWrite: 0,
							totalTokens: 45_010,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				],
			};
			for (const handler of handlers.get("agent_end") ?? []) await handler(agentEnd, ctx);
			await vi.advanceTimersByTimeAsync(300_000);
			if (warmed === undefined) throw new Error("keep-alive never pinged");
			return { leading: leadingOf(warmed), turnStablePrefix: STABLE };
		},
	],
];

describe("every request built from the system prompt splits it like the turn request (senpi#4447 review)", () => {
	it.each(REQUEST_PATHS)(
		"%s sends the stable prefix as the block holding the system breakpoint",
		async (_name, send) => {
			// Given the system prompt the turn request split at its stable prefix.
			// When this request path builds its provider request.
			const { leading, turnStablePrefix } = await send();

			// Then its Anthropic system blocks begin with the same stable block, which alone holds the breakpoint.
			if (leading === undefined) throw new Error("request carried no leading system message");
			const blocks = anthropicSystemTextBlocks(getSystemMessageText(leading), leading.stablePrefix, CACHE);
			expect(blocks[0]).toEqual({ type: "text", text: turnStablePrefix, cache_control: CACHE });
			expect(blocks.slice(1).every((block) => block.cache_control === undefined)).toBe(true);
		},
	);
});
