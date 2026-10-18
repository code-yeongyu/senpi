import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { runOpenAiRemoteCompaction } from "../../src/core/extensions/builtin/compaction/openai-remote.ts";
import {
	isOpenAiRemoteCompactionModel,
	matchesOpenAiRemoteCompactionIdentity,
	openAiRemoteCompactionIdentity,
	parseOpenAiRemoteCompactionIdentity,
} from "../../src/core/extensions/builtin/compaction/openai-remote-model.ts";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

type RemoteCompactionV2Compat = NonNullable<Model<"openai-responses">["compat"]> & {
	supportsRemoteCompactionV2?: boolean;
};

type RemoteCompactionV2Model = Model<"openai-responses"> & {
	compat?: RemoteCompactionV2Compat;
};

const CUSTOM_MODEL = {
	id: "gpt-5.6-sol-fast",
	name: "GPT 5.6 Sol Fast",
	api: "openai-responses",
	provider: "quotio-openai",
	baseUrl: "https://quotio.example/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
	compat: { supportsRemoteCompactionV2: true, supportsWebSocket: false },
} satisfies RemoteCompactionV2Model;

const OPENAI_MODEL = {
	...CUSTOM_MODEL,
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	compat: undefined,
} satisfies RemoteCompactionV2Model;

function userEntry(id: string, text: string, timestamp: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
	};
}

function compactionEvent(): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		requestId: "request-native-v2",
		preparation: {
			messagesToSummarize: [],
			turnPrefixMessages: [],
			firstKeptEntryId: "u1",
			tokensBefore: 120_000,
			isSplitTurn: false,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		branchEntries: [userEntry("u1", "Please inspect the build.", "2026-03-31T00:00:00.000Z")],
		signal: new AbortController().signal,
		customInstructions: undefined,
		reason: "threshold",
		willRetry: false,
	};
}

function completedCompactionMessage(model: RemoteCompactionV2Model): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "providerNative",
				subtype: "compaction",
				raw: { type: "compaction", id: "cmp_123", encrypted_content: "encrypted-summary" },
			},
		],
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

function streamRunner(model: RemoteCompactionV2Model, captured: { payload?: unknown; options?: SimpleStreamOptions }) {
	return vi.fn(
		(
			_model: Model<Api>,
			_context: unknown,
			options?: SimpleStreamOptions,
		): { result: () => Promise<AssistantMessage> } => ({
			result: async () => {
				captured.options = options;
				captured.payload = await options?.onPayload?.({ model: model.id, input: [] }, model);
				return completedCompactionMessage(model);
			},
		}),
	);
}

async function run(model: RemoteCompactionV2Model) {
	const captured: { payload?: unknown; options?: SimpleStreamOptions } = {};
	const emitted: unknown[] = [];
	const stream = streamRunner(model, captured);
	const result = await runOpenAiRemoteCompaction(
		{
			model,
			serviceTier: undefined,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
			},
			sessionManager: { getSessionId: () => "session-native-v2" },
			getSystemPrompt: () => "You are senpi.",
		},
		compactionEvent(),
		(event) => emitted.push(event),
		{
			streamRunner: stream,
			fetch: vi.fn(async () => {
				throw new Error("legacy compact endpoint must not run when v2 succeeds");
			}),
		},
	);
	return { captured, emitted, result, stream };
}

describe("OpenAI remote compaction v2 routing", () => {
	it.each([
		["official OpenAI", OPENAI_MODEL],
		["explicit custom proxy", CUSTOM_MODEL],
	])("uses the Responses v2 trigger for %s", async (_label, model) => {
		const { captured, emitted, result, stream } = await run(model);

		expect(stream).toHaveBeenCalledOnce();
		expect(captured.options?.headers).toMatchObject({
			"x-codex-beta-features": "remote_compaction_v2",
		});
		expect(captured.payload).toMatchObject({
			input: expect.arrayContaining([expect.objectContaining({ type: "compaction_trigger" })]),
		});
		expect(result?.details).toMatchObject({
			provider: model.provider,
			api: "openai-responses",
			transport: "responses-v2",
		});
		expect(emitted).toEqual([
			expect.objectContaining({ action: "remote_started", transport: "responses-v2" }),
			expect.objectContaining({ action: "remote_completed", transport: "responses-v2" }),
		]);
	});

	it("keeps custom proxies local unless they opt in", () => {
		const optedOut = {
			...CUSTOM_MODEL,
			compat: { supportsRemoteCompactionV2: false, supportsWebSocket: false },
		} satisfies RemoteCompactionV2Model;
		const omitted = {
			...CUSTOM_MODEL,
			compat: { supportsWebSocket: false },
		} satisfies RemoteCompactionV2Model;

		expect(isOpenAiRemoteCompactionModel(optedOut)).toBe(false);
		expect(isOpenAiRemoteCompactionModel(omitted)).toBe(false);
		expect(isOpenAiRemoteCompactionModel(CUSTOM_MODEL)).toBe(true);
		expect(isOpenAiRemoteCompactionModel(OPENAI_MODEL)).toBe(true);
	});

	it("persists and matches the exact custom provider identity", () => {
		const identity = openAiRemoteCompactionIdentity(CUSTOM_MODEL);

		expect(identity).toEqual({ provider: "quotio-openai", api: "openai-responses" });
		expect(parseOpenAiRemoteCompactionIdentity("quotio-openai", "openai-responses")).toEqual(identity);
		expect(matchesOpenAiRemoteCompactionIdentity(CUSTOM_MODEL, identity)).toBe(true);
		expect(matchesOpenAiRemoteCompactionIdentity({ ...CUSTOM_MODEL, provider: "another-proxy" }, identity)).toBe(
			false,
		);
	});
});
