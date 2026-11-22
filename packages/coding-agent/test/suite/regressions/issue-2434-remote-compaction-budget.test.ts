import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import { SUMMARIZATION_TOTAL_BUDGET_MS } from "../../../src/core/compaction/stream-watchdog.ts";
import { runOpenAiRemoteCompaction } from "../../../src/core/extensions/builtin/compaction/openai-remote.ts";
import type { SessionBeforeCompactEvent } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { CODEX_MODEL, codexToken, GATEWAY_MODEL, OPENAI_MODEL } from "./issue-2434-remote-compaction-support.ts";

// senpi#2434: the remote compaction budget must grow with the context being
// compacted (a 383k-token subscription compaction took ~257 s live) while small
// compactions still give up quickly on a hung endpoint.

// Slowest rate measured on the subscription lane (17.74 s at 16.7k tokens, senpi#2434).
const SUBSCRIPTION_MS_PER_TOKEN = 1.06;
// Rate measured through an OpenAI-compatible gateway (12.7 s at ~18.8k tokens, senpi#2434).
const GATEWAY_MS_PER_TOKEN = 0.68;

const SESSION_ID = "issue-2434-session";
const COMPACTION_ITEM = { type: "compaction", id: "cmp_2434", encrypted_content: "encrypted-2434" };

function branch(model: Model<Api>): SessionEntry[] {
	const at = (offset: number) => new Date(1_775_000_000_000 + offset).toISOString();
	return [
		{
			type: "model_change",
			id: "model",
			parentId: null,
			timestamp: at(0),
			provider: model.provider,
			modelId: model.id,
		},
		{
			type: "message",
			id: "u1",
			parentId: "model",
			timestamp: at(1),
			message: { role: "user", content: [{ type: "text", text: "Inspect the failing build." }], timestamp: 1 },
		},
		{
			type: "message",
			id: "u2",
			parentId: "u1",
			timestamp: at(2),
			message: { role: "user", content: [{ type: "text", text: "Keep the diagnosis." }], timestamp: 2 },
		},
	];
}

function compactionEvent(model: Model<Api>, tokensBefore: number): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: false,
		requestId: "issue-2434",
		preparation: {
			firstKeptEntryId: "u2",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		branchEntries: branch(model),
		signal: new AbortController().signal,
	};
}

function compactionMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "providerNative", subtype: "compaction", raw: COMPACTION_ITEM }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_775_000_000_100,
	};
}

function remoteEndpoint(model: Model<Api>, latencyMs: number | undefined) {
	const calls: SimpleStreamOptions[] = [];
	const streamSimple = vi.fn((streamModel: Model<Api>, _context: unknown, options: SimpleStreamOptions) => {
		calls.push(options);
		return {
			result: async () => {
				await options.onPayload?.({ model: streamModel.id, input: [] }, streamModel);
				return new Promise<AssistantMessage>((resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
						once: true,
					});
					if (latencyMs !== undefined) setTimeout(() => resolve(compactionMessage(model)), latencyMs);
				});
			},
		};
	});
	return { calls, streamSimple };
}

function remoteContext(model: Model<Api>, streamSimple: ReturnType<typeof remoteEndpoint>["streamSimple"]) {
	const apiKey = model.api === "openai-codex-responses" ? codexToken() : "sk-issue-2434";
	return {
		model,
		serviceTier: undefined,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey }),
			modelRuntime: { streamSimple },
		},
		sessionManager: { getSessionId: () => SESSION_ID },
		getSystemPrompt: () => "You are senpi.",
	};
}

async function compactRemotely(model: Model<Api>, tokensBefore: number, latencyMs: number | undefined) {
	const endpoint = remoteEndpoint(model, latencyMs);
	const emitted: Array<Record<string, unknown>> = [];
	const startedAt = Date.now();
	const pending = runOpenAiRemoteCompaction(
		remoteContext(model, endpoint.streamSimple),
		compactionEvent(model, tokensBefore),
		(event) => emitted.push(event),
		{
			fetch: vi.fn(async () => new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 })),
		},
	);
	await vi.runAllTimersAsync();
	const result = await pending;
	const timedOutAt = emitted.find((event) => event.reason === "remote-compaction-timeout") ? Date.now() : undefined;
	return {
		result,
		emitted,
		calls: endpoint.calls,
		elapsedMs: (timedOutAt ?? Date.now()) - startedAt,
		totalMs: Date.now() - startedAt,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("issue #2434: remote compaction budget scales with the context being compacted", () => {
	it("lets a 383k-token subscription compaction finish instead of timing out", async () => {
		vi.useFakeTimers();
		const tokens = 383_006;

		const { result, emitted, calls } = await compactRemotely(
			CODEX_MODEL,
			tokens,
			Math.ceil(tokens * SUBSCRIPTION_MS_PER_TOKEN),
		);

		expect(emitted.some((event) => event.reason === "remote-compaction-timeout")).toBe(false);
		expect(result?.details.transport).toBe("responses-v2");
		expect(result?.tokensBefore).toBe(tokens);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.signal?.aborted).toBe(false);
	});

	it("still gives up promptly on a hung endpoint for a small compaction, sooner than for a large one", async () => {
		vi.useFakeTimers();

		const small = await compactRemotely(CODEX_MODEL, 16_735, undefined);
		const large = await compactRemotely(CODEX_MODEL, 383_006, undefined);

		// A hung request is still detected and abandoned, so the local fallback can start.
		expect(small.result).toBeUndefined();
		expect(small.calls[0]?.signal?.aborted).toBe(true);
		expect(small.emitted).toContainEqual(expect.objectContaining({ reason: "remote-compaction-timeout" }));
		// A small session never waits longer than two minutes on a dead endpoint...
		expect(small.elapsedMs).toBeLessThanOrEqual(120_000);
		// ...while only a large one is given the longer wait its size needs.
		expect(large.result).toBeUndefined();
		expect(large.elapsedMs).toBeGreaterThan(small.elapsedMs);
		expect(large.elapsedMs).toBeGreaterThanOrEqual(Math.ceil(383_006 * SUBSCRIPTION_MS_PER_TOKEN));
	});

	it.each([
		["the OpenAI lane", OPENAI_MODEL],
		["a v2-compatible gateway", GATEWAY_MODEL],
	] as const)("scales %s with its own, shorter floor", async (_label, model) => {
		vi.useFakeTimers();
		const tokens = 120_000;

		const large = await compactRemotely(model, tokens, Math.ceil(tokens * GATEWAY_MS_PER_TOKEN));
		const smallHang = await compactRemotely(model, 4_000, undefined);
		const subscriptionSmallHang = await compactRemotely(CODEX_MODEL, 4_000, undefined);

		// A large compaction on this lane gets room to finish...
		expect(large.emitted.some((event) => event.reason === "remote-compaction-timeout")).toBe(false);
		expect(large.result?.details.transport).toBe("responses-v2");
		// ...while a tiny one that hangs is abandoned faster than the subscription lane's floor.
		expect(smallHang.result).toBeUndefined();
		expect(smallHang.emitted).toContainEqual(expect.objectContaining({ reason: "remote-compaction-timeout" }));
		expect(smallHang.elapsedMs).toBeLessThan(subscriptionSmallHang.elapsedMs);
	});

	it("bounds the whole remote phase when every OpenAI route hangs, then hands over to the local summary", async () => {
		vi.useFakeTimers();

		const { result, emitted, calls, totalMs } = await compactRemotely(OPENAI_MODEL, 600_000, undefined);

		expect(result).toBeUndefined();
		expect(totalMs).toBeLessThanOrEqual(SUMMARIZATION_TOTAL_BUDGET_MS);
		expect(calls).toHaveLength(1);
		const timeouts = emitted.filter((event) => event.reason === "remote-compaction-timeout");
		expect(timeouts).toHaveLength(1);
		expect(timeouts[0]).toMatchObject({ timeout: { next: "local-summary", tokens: 600_000 } });
	});
});
