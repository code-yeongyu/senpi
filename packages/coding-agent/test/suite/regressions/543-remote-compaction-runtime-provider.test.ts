import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import { runOpenAiRemoteCompaction } from "../../../src/core/extensions/builtin/compaction/openai-remote.ts";
import type { SessionBeforeCompactEvent } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";

const EXTENSION_MODEL = {
	id: "proxy-model",
	name: "Proxy model",
	api: "openai-responses",
	provider: "extension-responses-proxy",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
	compat: { supportsRemoteCompactionV2: true, supportsWebSocket: false },
} satisfies Model<"openai-responses">;

function userEntry(): SessionEntry {
	return {
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: "2026-03-31T00:00:00.000Z",
		message: { role: "user", content: "inspect the build", timestamp: Date.parse("2026-03-31T00:00:00.000Z") },
	};
}

function compactionEvent(): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		requestId: "request-extension-remote",
		preparation: {
			messagesToSummarize: [],
			turnPrefixMessages: [],
			firstKeptEntryId: "u1",
			tokensBefore: 120_000,
			isSplitTurn: false,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		branchEntries: [userEntry()],
		signal: new AbortController().signal,
		customInstructions: undefined,
		reason: "threshold",
		willRetry: false,
	};
}

function compactionMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "providerNative",
				subtype: "compaction",
				raw: { type: "compaction", id: "cmp_ext", encrypted_content: "encrypted-summary" },
			},
		],
		api: EXTENSION_MODEL.api,
		provider: EXTENSION_MODEL.provider,
		model: EXTENSION_MODEL.id,
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

describe("issue #543: remote compaction for a runtime-registered provider", () => {
	it("dispatches the native remote-compaction request through the model runtime", async () => {
		// Given an extension provider that owns its own transport for api "openai-responses"
		// and opts into native remote compaction.
		const runtimeStream = vi.fn((_model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => ({
			result: async () => {
				await options?.onPayload?.({ model: EXTENSION_MODEL.id, input: [] }, EXTENSION_MODEL);
				return compactionMessage();
			},
		}));

		// When the remote compaction route runs with no injected stream runner.
		const result = await runOpenAiRemoteCompaction(
			{
				model: EXTENSION_MODEL,
				serviceTier: undefined,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "extension-key" }),
					modelRuntime: { streamSimple: runtimeStream },
				},
				sessionManager: { getSessionId: () => "session-extension-remote" },
				getSystemPrompt: () => "You are senpi.",
			},
			compactionEvent(),
			undefined,
			{
				fetch: vi.fn(async () => {
					throw new Error("legacy compact endpoint must not run");
				}),
			},
		);

		// Then the provider's own transport served the request instead of compat's builtin api.
		expect(runtimeStream).toHaveBeenCalledTimes(1);
		expect(result?.details.transport).toBe("responses-v2");
	});
});
