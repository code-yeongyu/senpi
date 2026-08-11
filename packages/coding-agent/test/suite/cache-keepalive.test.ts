import type { Model, WarmPromptCacheResult } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CACHE_KEEPALIVE_ENTRY_TYPE,
	createCacheKeepAliveExtension,
	renderCacheKeepAliveEntry,
} from "../../src/core/extensions/builtin/cache-keepalive/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const model: Model<"anthropic-messages"> = {
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

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function harness(
	options: {
		warm?: () => Promise<WarmPromptCacheResult>;
		maxRequests?: number;
		maxCost?: number;
		goalArmed?: boolean;
	} = {},
) {
	const handlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const entries: Array<{ customType: string; data: any }> = [];
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const notifications: string[] = [];
	let idle = true;
	let pending = false;
	const warm = vi.fn(
		options.warm ??
			(async () => ({
				supported: true,
				usage: { input: 0, output: 0, cacheRead: 45_000, cacheWrite: 0 },
				usageRaw: {},
			})),
	);
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		registerEntryRenderer: vi.fn(),
		getActiveTools: () => [],
		getAllTools: () => [],
		events: {
			emit: (channel: string, data: unknown) => {
				emitted.push({ channel, data });
				for (const handler of busHandlers.get(channel) ?? []) handler(data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
				return () => {};
			},
		},
	} as unknown as ExtensionAPI;
	createCacheKeepAliveExtension({ warmPromptCache: warm })(pi);
	const ctx = {
		model,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		getPromptCacheSafeWaitSeconds: () => 300,
		getPromptCacheKeepAliveSettings: () => ({
			enabled: true,
			maxRequestsPerSession: options.maxRequests ?? 3,
			maxCostUsdPerSession: options.maxCost ?? 1,
			marginSeconds: 60,
		}),
		getSystemPrompt: () => "system",
		prepareProviderRequest: async (messages: any[]) => ({
			messages,
			transformPayload: async (payload: unknown) => payload,
			transformHeaders: async (headers: any) => headers,
		}),
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
		},
		sessionManager: { getSessionId: () => "session-1" },
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
	async function fire(event: string, data: any = { type: event }) {
		for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
	}
	if (options.goalArmed) pi.events?.emit("goal_continuation_timer_state", { armed: true, kind: "monitor" });
	return {
		pi,
		ctx,
		fire,
		warm,
		entries,
		emitted,
		notifications,
		setIdle: (v: boolean) => (idle = v),
		setPending: (v: boolean) => (pending = v),
	};
}

const agentEnd = {
	type: "agent_end",
	messages: [
		{ role: "user", content: "hello", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			timestamp: 2,
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

async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

describe("cache keep-alive", () => {
	beforeAll(() => initTheme("dark"));
	afterAll(() => vi.restoreAllMocks());
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("pings at safeWait-margin with iteration 1 when enabled and idle", async () => {
		const h = harness();
		await h.fire("agent_end", agentEnd);
		await advance(239_999);
		expect(h.warm).not.toHaveBeenCalled();
		await advance(1);
		expect(h.warm).toHaveBeenCalledOnce();
		expect(h.emitted).toContainEqual({
			channel: "cache_warm_ping",
			data: expect.objectContaining({ iteration: 1, cachedTokens: 45_000, ttlSeconds: 3600 }),
		});
	});

	it("does not ping while a goal continuation timer is armed", async () => {
		const h = harness({ goalArmed: true });
		await h.fire("agent_end", agentEnd);
		await advance(300_000);
		expect(h.warm).not.toHaveBeenCalled();
	});

	it("stops after three attempted pings and rejects a fourth arm", async () => {
		const h = harness();
		await h.fire("agent_end", agentEnd);
		await advance(240_000 * 3);
		expect(h.warm).toHaveBeenCalledTimes(3);
		await advance(240_000);
		expect(h.warm).toHaveBeenCalledTimes(3);
		expect(h.entries.map((entry) => entry.data.phase)).toEqual(["started", "ping", "ping", "ping", "stopped"]);
		expect(h.entries.at(-1)?.data.stopReason).toBe("max-requests");
	});

	it("rejects the first arm when projected cost exceeds the cap", async () => {
		const h = harness({ maxCost: 0.0001 });
		await h.fire("agent_end", agentEnd);
		await advance(300_000);
		expect(h.warm).not.toHaveBeenCalled();
		expect(h.entries.at(-1)?.data).toMatchObject({ phase: "stopped", stopReason: "cost-cap" });
	});

	it("aborts a pending timer on user input", async () => {
		const h = harness();
		await h.fire("agent_end", agentEnd);
		await advance(100_000);
		await h.fire("input", { type: "input", text: "new work", source: "interactive" });
		await advance(200_000);
		expect(h.warm).not.toHaveBeenCalled();
		expect(h.entries.at(-1)?.data.stopReason).toBe("user-input");
	});

	it("stops silently on provider error", async () => {
		const h = harness({ warm: async () => Promise.reject(new Error("429 rate limited")) });
		await h.fire("agent_end", agentEnd);
		await advance(240_000);
		expect(h.notifications).toEqual([]);
		expect(h.entries.at(-1)?.data).toMatchObject({ phase: "stopped", stopReason: "provider-error", iterations: 1 });
	});

	it("renders the warm ping notice through the shared entry renderer", () => {
		const component = renderCacheKeepAliveEntry(
			{
				type: "custom",
				id: "entry",
				parentId: null,
				timestamp: "2026-08-09T00:00:00.000Z",
				customType: CACHE_KEEPALIVE_ENTRY_TYPE,
				data: {
					phase: "ping",
					iteration: 1,
					cacheRead: 45_000,
					cacheWrite: 0,
					estimatedCostUsd: 0.005,
					cumulativeEstimatedUsd: 0.005,
				},
			},
			{ expanded: false },
			theme,
		);
		expect(component?.render(100).join("\n")).toContain("⚡ Warm ping #1 · ~45K tokens refreshed · $0.005");
	});
});
