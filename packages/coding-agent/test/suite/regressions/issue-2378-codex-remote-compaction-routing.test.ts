import {
	type Api,
	type AssistantMessage,
	convertResponsesMessages,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import {
	markOpenAiRemoteReplayBoundary,
	rewriteOpenAiPayloadWithRemoteCompaction,
	runOpenAiRemoteCompaction,
} from "../../../src/core/extensions/builtin/compaction/openai-remote.ts";
import {
	createOpenAiRemoteCompactionHeaders,
	matchesOpenAiRemoteCompactionIdentity,
	openAiRemoteCompactionOrigin,
} from "../../../src/core/extensions/builtin/compaction/openai-remote-model.ts";
import type { SessionBeforeCompactEvent } from "../../../src/core/extensions/types.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { buildSessionContext, type SessionEntry } from "../../../src/core/session-manager.ts";

// senpi#2378: the ChatGPT subscription lane compacts through responses-v2 over the
// provider-turn transport, stores a checkpoint its own replay accepts, and costs at
// most one remote request per compaction.

const CODEX_MODEL = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	api: "openai-codex-responses",
	provider: "chatgpt-subscription",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 16_384,
} satisfies Model<"openai-codex-responses">;

const OPENAI_MODEL = {
	...CODEX_MODEL,
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
} satisfies Model<"openai-responses">;

const SESSION_ID = "issue-2378-session";
const COMPACTION_ITEM = { type: "compaction", id: "cmp_2378", encrypted_content: "encrypted-2378" };

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account_2378" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function branch(): SessionEntry[] {
	const at = (offset: number) => new Date(1_775_000_000_000 + offset).toISOString();
	return [
		{
			type: "model_change",
			id: "model",
			parentId: null,
			timestamp: at(0),
			provider: CODEX_MODEL.provider,
			modelId: CODEX_MODEL.id,
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

function compactionEvent(entries: SessionEntry[]): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: false,
		requestId: "issue-2378",
		preparation: {
			firstKeptEntryId: "u2",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 120_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		branchEntries: entries,
		signal: new AbortController().signal,
	};
}

function compactionMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "providerNative", subtype: "compaction", raw: COMPACTION_ITEM }],
		api: CODEX_MODEL.api,
		provider: CODEX_MODEL.provider,
		model: CODEX_MODEL.id,
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

type StreamCall = { model: Model<Api>; options: SimpleStreamOptions; payload?: unknown };

function setup(respond: (call: StreamCall) => Promise<AssistantMessage> = async () => compactionMessage()) {
	const calls: StreamCall[] = [];
	const fetchCalls: string[] = [];
	const emitted: Array<Record<string, unknown>> = [];
	const streamSimple = vi.fn((model: Model<Api>, _context: unknown, options: SimpleStreamOptions) => {
		const call: StreamCall = { model, options };
		calls.push(call);
		return {
			result: async () => {
				call.payload = await options.onPayload?.(
					{ model: model.id, instructions: "You are senpi.", input: [] },
					model,
				);
				return respond(call);
			},
		};
	});
	const token = codexToken();
	const ctx = {
		model: CODEX_MODEL,
		serviceTier: undefined,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: token }),
			modelRuntime: { streamSimple },
		},
		sessionManager: { getSessionId: () => SESSION_ID },
		getSystemPrompt: () => "You are senpi.",
	};
	const run = (entries = branch()) =>
		runOpenAiRemoteCompaction(ctx, compactionEvent(entries), (event) => emitted.push(event), {
			fetch: vi.fn(async (url: string | URL | Request) => {
				fetchCalls.push(String(url));
				return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
			}),
		});
	return { calls, emitted, fetchCalls, run, streamSimple, token };
}

function replayOrigin(token: string) {
	const headers = createOpenAiRemoteCompactionHeaders(CODEX_MODEL, { apiKey: token }, SESSION_ID);
	const origin = headers ? openAiRemoteCompactionOrigin(CODEX_MODEL, headers) : undefined;
	if (!origin) throw new Error("Expected the Codex replay origin");
	return origin;
}

function nextTurnPayload(entries: SessionEntry[]) {
	const marked = markOpenAiRemoteReplayBoundary(
		[
			...buildSessionContext(entries).messages,
			{ role: "user", content: [{ type: "text", text: "Continue after compaction." }], timestamp: 4 },
		],
		{ model: CODEX_MODEL, branchEntries: entries },
	);
	return {
		model: CODEX_MODEL.id,
		input: convertResponsesMessages(
			CODEX_MODEL,
			normalizeContext({ messages: convertToLlm(marked) }),
			new Set(["chatgpt-subscription"]),
			{
				includeSystemPrompt: false,
				preserveTextSignatures: true,
			},
		),
		stream: true,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("issue #2378: ChatGPT subscription remote compaction", () => {
	it("compacts through responses-v2 and never calls the retired /codex/responses/compact route", async () => {
		const { calls, emitted, fetchCalls, run } = setup();

		const result = await run();

		expect(result?.details.transport).toBe("responses-v2");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.headers?.["x-codex-beta-features"]).toContain("remote_compaction_v2");
		expect(calls[0]?.payload).toMatchObject({
			input: expect.arrayContaining([expect.objectContaining({ type: "compaction_trigger" })]),
		});
		expect(fetchCalls).toEqual([]);
		expect(emitted.map((event) => [event.action, event.transport])).toEqual([
			["remote_started", "responses-v2"],
			["remote_completed", "responses-v2"],
		]);
	});

	it("stores a checkpoint with the lane's own identity that the next turn replays", async () => {
		const { run, token } = setup();

		const result = await run();
		if (!result) throw new Error("Expected a responses-v2 checkpoint");

		expect(result.details).toMatchObject({ provider: "chatgpt-subscription", api: "openai-codex-responses" });
		expect(matchesOpenAiRemoteCompactionIdentity(CODEX_MODEL, result.details)).toBe(true);
		expect(result.details.origin).toEqual(replayOrigin(token));

		const compacted: SessionEntry[] = [
			...branch(),
			{
				type: "compaction",
				id: "checkpoint",
				parentId: "u2",
				timestamp: new Date(1_775_000_002_000).toISOString(),
				summary: result.summary,
				firstKeptEntryId: result.firstKeptEntryId,
				tokensBefore: result.tokensBefore,
				details: result.details,
				fromHook: true,
			},
		];
		const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(nextTurnPayload(compacted), {
			model: CODEX_MODEL,
			branchEntries: compacted,
			origin: replayOrigin(token),
		}) as { input?: unknown[] } | undefined;
		expect(rewritten?.input).toContainEqual(COMPACTION_ITEM);
		expect(JSON.stringify(rewritten?.input)).not.toContain(result.summary);
	});

	it("gives a slow real compaction more than 15 seconds and makes exactly one remote request", async () => {
		vi.useFakeTimers();
		let release: (() => void) | undefined;
		const { calls, emitted, fetchCalls, run } = setup(
			() =>
				new Promise((resolve) => {
					release = () => resolve(compactionMessage());
				}),
		);

		const pending = run();
		await vi.advanceTimersByTimeAsync(15_001);
		expect(emitted.some((event) => event.reason === "remote-compaction-timeout")).toBe(false);
		release?.();
		const result = await pending;

		expect(result?.details.transport).toBe("responses-v2");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.maxRetries).toBe(0);
		expect(fetchCalls).toEqual([]);
	});

	it("falls back to the local summary after one failed remote attempt, with no second route", async () => {
		const { calls, emitted, fetchCalls, run } = setup(async () => ({
			...compactionMessage(),
			content: [],
			stopReason: "error",
			errorMessage: "upstream failure",
		}));

		const result = await run();

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(fetchCalls).toEqual([]);
		expect(emitted.filter((event) => event.action === "remote_started")).toHaveLength(1);
	});

	it("stores no checkpoint when the one remote attempt times out, even if it answers late", async () => {
		vi.useFakeTimers();
		let release: (() => void) | undefined;
		const { calls, emitted, fetchCalls, run } = setup(
			() =>
				new Promise((resolve) => {
					release = () => resolve(compactionMessage());
				}),
		);

		const pending = run();
		await vi.runAllTimersAsync();
		const result = await pending;
		release?.();

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.signal?.aborted).toBe(true);
		expect(fetchCalls).toEqual([]);
		expect(emitted.filter((event) => event.action === "remote_completed")).toEqual([]);
		expect(emitted).toContainEqual(expect.objectContaining({ reason: "remote-compaction-timeout" }));
	});

	it("replays an OpenAI-lane responses-v2 checkpoint with the origin later turns present", async () => {
		const apiKey = "sk-issue-2378";
		const stream = vi.fn((model: Model<Api>, _context: unknown, options: SimpleStreamOptions) => ({
			result: async () => {
				await options.onPayload?.({ model: model.id, input: [] }, model);
				return { ...compactionMessage(), api: OPENAI_MODEL.api, provider: OPENAI_MODEL.provider };
			},
		}));
		const result = await runOpenAiRemoteCompaction(
			{
				model: OPENAI_MODEL,
				serviceTier: undefined,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey }),
					modelRuntime: { streamSimple: stream },
				},
				sessionManager: { getSessionId: () => SESSION_ID },
				getSystemPrompt: () => "You are senpi.",
			},
			compactionEvent(branch()),
		);
		if (!result) throw new Error("Expected an OpenAI responses-v2 checkpoint");
		expect(result.details.transport).toBe("responses-v2");

		const turnHeaders = createOpenAiRemoteCompactionHeaders(OPENAI_MODEL, { apiKey }, SESSION_ID);
		const turnOrigin = turnHeaders ? openAiRemoteCompactionOrigin(OPENAI_MODEL, turnHeaders) : undefined;
		expect(result.details.origin).toEqual(turnOrigin);
	});

	it("sends the compaction through the provider-turn transport, not a bare fetch", async () => {
		const { calls, fetchCalls, run, streamSimple, token } = setup();

		await run();

		expect(streamSimple).toHaveBeenCalledTimes(1);
		expect(calls[0]?.model).toMatchObject({ provider: "chatgpt-subscription", api: "openai-codex-responses" });
		expect(calls[0]?.options).toMatchObject({ apiKey: token, sessionId: SESSION_ID, transport: "sse" });
		expect(fetchCalls).toEqual([]);
	});
});
