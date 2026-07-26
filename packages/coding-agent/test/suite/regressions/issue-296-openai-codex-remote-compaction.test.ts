import { arch, platform, release } from "node:os";
import { type Api, type AssistantMessage, convertResponsesMessages, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import {
	markOpenAiRemoteReplayBoundary,
	OPENAI_REMOTE_COMPACTION_SCHEMA,
	rewriteOpenAiPayloadWithRemoteCompaction,
	runOpenAiRemoteCompaction,
} from "../../../src/core/extensions/builtin/compaction/openai-remote.ts";
import {
	createOpenAiRemoteCompactionHeaders,
	openAiRemoteCompactionOrigin,
} from "../../../src/core/extensions/builtin/compaction/openai-remote-model.ts";
import type { SessionBeforeCompactEvent } from "../../../src/core/extensions/types.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { buildSessionContext, type SessionEntry, type SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { createHarness } from "../harness.ts";

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

function codexToken(accountId = "account_issue_296", nonce = "initial"): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
			nonce,
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function codexReplayOrigin(token: string) {
	const headers = createOpenAiRemoteCompactionHeaders(CODEX_MODEL, { apiKey: token }, "stable-account-session");
	const origin = headers ? openAiRemoteCompactionOrigin(CODEX_MODEL, headers) : undefined;
	if (!origin) throw new Error("Expected a canonical Codex replay origin");
	return origin;
}

function branchWithRemoteCheckpoint(
	branch: SessionEntry[],
	result: NonNullable<Awaited<ReturnType<typeof runOpenAiRemoteCompaction>>>,
): SessionEntry[] {
	return [
		...branch,
		{
			type: "compaction",
			id: "remote-checkpoint",
			parentId: "u2",
			timestamp: new Date(1_775_000_002_000).toISOString(),
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			details: result.details,
			fromHook: true,
		},
	];
}

function finalCodexReplayPayload(branchEntries: SessionEntry[]) {
	const markedContext = markOpenAiRemoteReplayBoundary(
		[
			...buildSessionContext(branchEntries).messages,
			{ role: "user", content: [{ type: "text", text: "Continue after compaction." }], timestamp: 4 },
		],
		{ model: CODEX_MODEL, branchEntries },
	);
	return {
		model: CODEX_MODEL.id,
		input: convertResponsesMessages(
			CODEX_MODEL,
			{ messages: convertToLlm(markedContext) },
			new Set(["openai-codex"]),
			{ includeSystemPrompt: false, preserveTextSignatures: true },
		),
		stream: true,
	};
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
		expect(calls[0]?.headers.has("session_id")).toBe(false);
		expect(calls[0]?.headers.get("session-id")).toBe("issue-296-session");
		expect(calls[0]?.headers.get("x-client-request-id")).toBe("issue-296-session");
		expect(calls[0]?.headers.has("thread-id")).toBe(false);
		expect(calls[0]?.headers.has("x-codex-installation-id")).toBe(false);
		expect(calls[0]?.headers.has("x-codex-window-id")).toBe(false);
		expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
		expect(calls[0]?.headers.get("user-agent")).toBe(`senpi (${platform()} ${release()}; ${arch()})`);
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
		const markedContext = markOpenAiRemoteReplayBoundary(
			[
				...buildSessionContext(compactedBranch).messages,
				{ role: "user", content: [{ type: "text", text: "Continue after compaction." }], timestamp: 4 },
			],
			{ model: CODEX_MODEL, branchEntries: compactedBranch },
		);
		const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(
			{
				model: CODEX_MODEL.id,
				input: convertResponsesMessages(
					CODEX_MODEL,
					{ messages: convertToLlm(markedContext) },
					new Set(["openai-codex"]),
					{ includeSystemPrompt: false, preserveTextSignatures: true },
				),
				stream: true,
			},
			{ model: CODEX_MODEL, branchEntries: compactedBranch, origin: result.details.origin },
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

	it("replays a Codex checkpoint across refreshed JWTs for only the same ChatGPT account", async () => {
		const accountA = "account-stable";
		const tokenA = codexToken(accountA, "issued-a");
		const tokenB = codexToken(accountA, "refreshed-b");
		const tokenC = codexToken("account-other", "issued-c");
		const branch = codexBranch();
		const result = await runOpenAiRemoteCompaction(
			{
				model: CODEX_MODEL,
				serviceTier: undefined,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: tokenA }),
				},
				sessionManager: { getSessionId: () => "stable-account-session" },
				getSystemPrompt: () => "You are Senpi.",
			},
			compactionEvent(CODEX_MODEL.api, branch),
			undefined,
			{
				fetch: async () =>
					new Response(
						JSON.stringify({
							output: [
								{
									type: "message",
									id: "retained",
									role: "user",
									content: [{ type: "input_text", text: "keep" }],
								},
								{ type: "compaction", id: "cmp_stable_account", encrypted_content: "stable-account-state" },
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			},
		);
		if (!result) throw new Error("Expected Codex remote compaction result");

		const persistedDetails = JSON.stringify(result.details);
		expect(persistedDetails).not.toContain(tokenA);
		expect(persistedDetails).not.toContain(tokenB);
		expect(persistedDetails).not.toContain(tokenC);

		const compactedBranch = branchWithRemoteCheckpoint(branch, result);
		const payload = finalCodexReplayPayload(compactedBranch);
		const replayedWithRefreshedToken = rewriteOpenAiPayloadWithRemoteCompaction(payload, {
			model: CODEX_MODEL,
			branchEntries: compactedBranch,
			origin: codexReplayOrigin(tokenB),
		}) as { input?: unknown[] } | undefined;
		expect(replayedWithRefreshedToken?.input).toEqual(
			expect.arrayContaining([
				{
					type: "compaction",
					id: "cmp_stable_account",
					encrypted_content: "stable-account-state",
				},
			]),
		);

		const replayedWithDifferentAccount = rewriteOpenAiPayloadWithRemoteCompaction(payload, {
			model: CODEX_MODEL,
			branchEntries: compactedBranch,
			origin: codexReplayOrigin(tokenC),
		});
		expect(replayedWithDifferentAccount).toBeUndefined();
	});

	it("keeps Codex compaction wire auth and replay provenance canonical when header hooks try to override them", async () => {
		const accountA = "account-wire-a";
		const accountB = "account-wire-b";
		const tokenA = codexToken(accountA, "wire-a");
		const tokenB = codexToken(accountB, "hook-b");
		const calls: Headers[] = [];
		const branch = codexBranch();
		const headerHookHarness = await createHarness({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [{ id: CODEX_MODEL.id, contextWindow: CODEX_MODEL.contextWindow, maxTokens: CODEX_MODEL.maxTokens }],
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_headers", (event) => {
						event.headers.authorization = `Bearer ${tokenB}`;
						event.headers["chatgpt-account-id"] = accountB;
					});
				},
			],
		});

		try {
			await headerHookHarness.session.bindExtensions({});
			const result = await runOpenAiRemoteCompaction(
				{
					model: CODEX_MODEL,
					serviceTier: undefined,
					modelRegistry: {
						getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: tokenA }),
					},
					sessionManager: { getSessionId: () => "canonical-wire-session" },
					getSystemPrompt: () => "You are Senpi.",
					prepareProviderRequest: async (messages) =>
						await headerHookHarness.getExtensionRunner().prepareProviderRequest(messages),
				},
				compactionEvent(CODEX_MODEL.api, branch),
				undefined,
				{
					fetch: async (_url, init) => {
						calls.push(new Headers(init?.headers));
						return new Response(
							JSON.stringify({
								output: [
									{
										type: "message",
										id: "retained",
										role: "user",
										content: [{ type: "input_text", text: "keep" }],
									},
									{ type: "compaction", id: "cmp_canonical_wire", encrypted_content: "canonical-wire-state" },
								],
							}),
							{ status: 200, headers: { "content-type": "application/json" } },
						);
					},
				},
			);
			if (!result) throw new Error("Expected Codex remote compaction result");

			expect(calls).toHaveLength(1);
			expect(calls[0]?.get("authorization")).toBe(`Bearer ${tokenA}`);
			expect(calls[0]?.get("chatgpt-account-id")).toBe(accountA);
			const wireOrigin = openAiRemoteCompactionOrigin(CODEX_MODEL, calls[0]!);
			expect(result.details.origin).toEqual(wireOrigin);
			expect(JSON.stringify(result.details)).not.toContain(tokenB);

			const compactedBranch = branchWithRemoteCheckpoint(branch, result);
			const replayed = rewriteOpenAiPayloadWithRemoteCompaction(finalCodexReplayPayload(compactedBranch), {
				model: CODEX_MODEL,
				branchEntries: compactedBranch,
				origin: wireOrigin,
			}) as { input?: unknown[] } | undefined;
			expect(replayed?.input).toContainEqual({
				type: "compaction",
				id: "cmp_canonical_wire",
				encrypted_content: "canonical-wire-state",
			});
		} finally {
			headerHookHarness.cleanup();
		}
	});
});
