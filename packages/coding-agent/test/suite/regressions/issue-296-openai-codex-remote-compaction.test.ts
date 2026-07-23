import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import {
	OPENAI_REMOTE_COMPACTION_SCHEMA,
	rewriteOpenAiPayloadWithRemoteCompaction,
	runOpenAiRemoteCompaction,
} from "../../../src/core/extensions/builtin/compaction/openai-remote.ts";
import type { SessionBeforeCompactEvent } from "../../../src/core/extensions/types.ts";
import type { SessionEntry, SessionMessageEntry } from "../../../src/core/session-manager.ts";

const CODEX_MODEL = {
	id: "gpt-5.4-codex",
	name: "GPT-5.4 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
} satisfies Model<"openai-codex-responses">;

const ANTHROPIC_MODEL = {
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
} satisfies Model<"anthropic-messages">;

function messageEntry(id: string, parentId: string | null, message: SessionMessageEntry["message"]): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(1_775_000_000_000 + id.length).toISOString(),
		message,
	};
}

function codexBranch(): SessionEntry[] {
	return [
		{
			type: "model_change",
			id: "model",
			parentId: null,
			timestamp: new Date(1_775_000_000_000).toISOString(),
			provider: "openai-codex",
			modelId: CODEX_MODEL.id,
		},
		messageEntry("u1", "model", {
			role: "user",
			content: [{ type: "text", text: "Inspect the failing build." }],
			timestamp: 1,
		}),
		messageEntry("a1", "u1", {
			role: "assistant",
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: CODEX_MODEL.id,
			content: [{ type: "text", text: "I found the failure." }],
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		} satisfies AssistantMessage),
		messageEntry("u2", "a1", {
			role: "user",
			content: [{ type: "text", text: "Keep the diagnosis." }],
			timestamp: 3,
		}),
	];
}

function compactionEvent(model: Api, branchEntries: SessionEntry[]): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: true,
		requestId: `issue-296-${model}`,
		preparation: {
			firstKeptEntryId: "u2",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1234,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		branchEntries,
		signal: new AbortController().signal,
	};
}

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "account_issue_296" },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("issue #296 OpenAI Codex remote compaction", () => {
	it("compacts through the Codex endpoint and replays retained history on the next request", async () => {
		const branch = codexBranch();
		const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
		const ctx = {
			model: CODEX_MODEL,
			serviceTier: undefined,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: codexToken() }),
			},
			sessionManager: { getSessionId: () => "issue-296-session" },
			getSystemPrompt: () => "You are Senpi.",
		};

		const result = await runOpenAiRemoteCompaction(ctx, compactionEvent(CODEX_MODEL.api, branch), undefined, {
			fetch: async (url, init) => {
				calls.push({
					url: String(url),
					headers: new Headers(init?.headers),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				return new Response(
					JSON.stringify({
						output: [
							{
								type: "message",
								id: "u1_remote",
								role: "user",
								content: [{ type: "input_text", text: "Inspect the failing build." }],
							},
							{ type: "compaction", id: "cmp_codex", encrypted_content: "encrypted-codex-summary" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		});

		expect(result, "Codex models must use native remote compaction").toBeDefined();
		if (!result) return;
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${codexToken()}`);
		expect(calls[0]?.headers.get("chatgpt-account-id")).toBe("account_issue_296");
		expect(calls[0]?.headers.get("originator")).toBe("senpi");
		expect(calls[0]?.headers.get("openai-beta")).toBe("responses=experimental");
		expect(calls[0]?.headers.get("session_id")).toBe("issue-296-session");
		expect(calls[0]?.headers.get("session-id")).toBe("issue-296-session");
		expect(calls[0]?.headers.get("thread-id")).toBe("issue-296-session");
		expect(calls[0]?.headers.get("x-codex-installation-id")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(calls[0]?.headers.get("x-codex-installation-id")).not.toBe("issue-296-session");
		expect(calls[0]?.headers.get("x-codex-window-id")).toBe("issue-296-session:0");
		expect(calls[0]?.headers.get("user-agent")).toBe("senpi");
		expect(result.details).toMatchObject({
			schema: OPENAI_REMOTE_COMPACTION_SCHEMA,
			provider: "openai-codex",
			api: "openai-codex-responses",
			transport: "compact-endpoint",
		});

		const compactedBranch: SessionEntry[] = [
			...branch,
			{
				type: "compaction",
				id: "compact",
				parentId: "u2",
				timestamp: new Date(1_775_000_002_000).toISOString(),
				summary: result.summary,
				firstKeptEntryId: result.firstKeptEntryId,
				tokensBefore: result.tokensBefore,
				details: result.details,
				fromHook: true,
			},
		];
		const pendingMessages = [
			{
				role: "user",
				content: [{ type: "text", text: "Continue after compaction." }],
				timestamp: 4,
			},
		] satisfies AgentMessage[];
		const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(
			{ model: CODEX_MODEL.id, input: [{ role: "developer", content: "Current prompt." }], stream: true },
			{ model: CODEX_MODEL, branchEntries: compactedBranch, pendingMessages },
		) as { input?: unknown[] } | undefined;

		expect(rewritten?.input).toContainEqual({
			type: "compaction",
			id: "cmp_codex",
			encrypted_content: "encrypted-codex-summary",
		});
		expect(rewritten?.input).toContainEqual({
			role: "user",
			content: [{ type: "input_text", text: "Continue after compaction." }],
		});
	});

	it("keeps unsupported providers outside native remote compaction", async () => {
		let compactCalls = 0;
		const ctx = {
			model: ANTHROPIC_MODEL,
			serviceTier: undefined,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "unused" }),
			},
			sessionManager: { getSessionId: () => "issue-296-anthropic" },
			getSystemPrompt: () => "You are Senpi.",
		};

		const result = await runOpenAiRemoteCompaction(
			ctx,
			compactionEvent(ANTHROPIC_MODEL.api, codexBranch()),
			undefined,
			{
				fetch: async () => {
					compactCalls += 1;
					throw new Error("unsupported provider must not reach the compact endpoint");
				},
			},
		);

		expect(result).toBeUndefined();
		expect(compactCalls).toBe(0);
	});
});
