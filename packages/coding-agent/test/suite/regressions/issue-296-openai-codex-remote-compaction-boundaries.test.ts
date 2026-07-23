import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import {
	OPENAI_REMOTE_COMPACTION_SCHEMA,
	rewriteOpenAiPayloadWithRemoteCompaction,
	runOpenAiRemoteCompaction,
} from "../../../src/core/extensions/builtin/compaction/openai-remote.ts";
import type { SessionBeforeCompactEvent } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";

const OPENAI_MODEL = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
} satisfies Model<"openai-responses">;

const CODEX_MODEL = {
	...OPENAI_MODEL,
	id: "gpt-5.4-codex",
	name: "GPT-5.4 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
} satisfies Model<"openai-codex-responses">;

function compactedBranch(provider: "openai" | "openai-codex"): SessionEntry[] {
	const isCodex = provider === "openai-codex";
	return [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: new Date(1_775_000_000_000).toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: "History before compaction." }],
				timestamp: 1,
			},
		},
		{
			type: "compaction",
			id: "compact",
			parentId: "u1",
			timestamp: new Date(1_775_000_001_000).toISOString(),
			summary: "Remote checkpoint.",
			firstKeptEntryId: "u1",
			tokensBefore: 100,
			fromHook: true,
			details: {
				schema: OPENAI_REMOTE_COMPACTION_SCHEMA,
				mode: "openai-remote",
				provider,
				api: isCodex ? "openai-codex-responses" : "openai-responses",
				transport: "compact-endpoint",
				modelId: isCodex ? CODEX_MODEL.id : OPENAI_MODEL.id,
				responseId: "remote-compact",
				createdAt: 1_775_000_001,
				requestInputItemCount: 1,
				retainedInputItemCount: 1,
				replacementInput: [{ type: "compaction", encrypted_content: "provider-owned-state" }],
			},
		},
	];
}

function event(branchEntries: SessionEntry[]): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: true,
		requestId: "issue-296-boundary",
		preparation: {
			firstKeptEntryId: "u1",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		branchEntries,
		signal: new AbortController().signal,
	};
}

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account_issue_296" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("issue #296 remote compaction boundaries", () => {
	it.each([
		{ current: CODEX_MODEL, persistedProvider: "openai" as const },
		{ current: OPENAI_MODEL, persistedProvider: "openai-codex" as const },
	])("does not replay $persistedProvider state through $current.provider", ({ current, persistedProvider }) => {
		const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(
			{ model: current.id, input: [], stream: true },
			{ model: current, branchEntries: compactedBranch(persistedProvider), pendingMessages: [] },
		);

		expect(rewritten).toBeUndefined();
	});

	it("does not send Codex OAuth compaction to an untrusted remote base URL", async () => {
		const model = { ...CODEX_MODEL, baseUrl: "https://attacker.example/backend-api" };
		let fetchCalls = 0;
		const ctx = {
			model,
			serviceTier: undefined,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: codexToken() }),
			},
			sessionManager: { getSessionId: () => "issue-296-untrusted-origin" },
			getSystemPrompt: () => "Sensitive system prompt.",
		};

		const result = await runOpenAiRemoteCompaction(ctx, event(compactedBranch("openai-codex")), undefined, {
			fetch: async () => {
				fetchCalls += 1;
				return new Response("unexpected", { status: 500 });
			},
		});

		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(0);
	});
});
