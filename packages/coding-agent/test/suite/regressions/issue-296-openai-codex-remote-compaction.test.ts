import { arch, platform, release } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import {
	type Api,
	type AssistantMessage,
	convertResponsesMessages,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamCodex } from "../../../../ai/src/api/openai-codex-responses.ts";
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
	provider: "chatgpt-subscription",
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
			provider: "chatgpt-subscription",
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
			provider: "chatgpt-subscription",
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

type WireCall = { url: string; headers: Headers; body: Record<string, unknown> };

function decodeWireBody(body: RequestInit["body"] | undefined): Record<string, unknown> {
	if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
	const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : (body as Uint8Array);
	return JSON.parse(Buffer.from(zstdDecompressSync(bytes)).toString("utf8")) as Record<string, unknown>;
}

// senpi#2378: the subscription lane compacts through responses-v2 on its provider-turn transport.
function stubCodexV2Wire(calls: WireCall[], compaction: Record<string, unknown>): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), headers: new Headers(init?.headers), body: decodeWireBody(init?.body) });
			const events = [
				{ type: "response.output_item.added", output_index: 0, item: compaction },
				{ type: "response.output_item.done", output_index: 0, item: compaction },
				{
					type: "response.completed",
					response: {
						id: "resp_v2",
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			];
			return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

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
			normalizeContext({ messages: convertToLlm(markedContext) }),
			new Set(["chatgpt-subscription"]),
			{ includeSystemPrompt: false, preserveTextSignatures: true },
		),
		stream: true,
	};
}

describe("issue #296 ChatGPT Subscription remote compaction", () => {
	it("compacts through responses-v2 and replays the checkpoint on the next request", async () => {
		const branch = codexBranch();
		const calls: WireCall[] = [];
		stubCodexV2Wire(calls, { type: "compaction", id: "cmp_codex", encrypted_content: "encrypted-codex-summary" });
		const ctx = {
			model: CODEX_MODEL,
			serviceTier: undefined,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: codexToken() }),
			},
			sessionManager: { getSessionId: () => "issue-296-session" },
			getSystemPrompt: () => "You are Senpi.",
		};

		const result = await runOpenAiRemoteCompaction(ctx, compactionEvent(CODEX_MODEL.api, branch));

		expect(result, "Codex models must use native remote compaction").toBeDefined();
		if (!result) return;
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(calls[0]?.body.input).toContainEqual({ type: "compaction_trigger" });
		expect(calls[0]?.headers.get("x-codex-beta-features")).toContain("remote_compaction_v2");
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${codexToken()}`);
		expect(calls[0]?.headers.get("chatgpt-account-id")).toBe("account_issue_296");
		expect(calls[0]?.headers.get("originator")).toBe("senpi");
		expect(calls[0]?.headers.get("openai-beta")).toBe("responses=experimental");
		expect(calls[0]?.headers.has("session_id")).toBe(false);
		expect(calls[0]?.headers.get("session-id")).toBe("issue-296-session");
		expect(calls[0]?.headers.get("x-client-request-id")).toBe("issue-296-session");
		expect(calls[0]?.headers.has("x-codex-installation-id")).toBe(false);
		expect(calls[0]?.headers.has("x-codex-window-id")).toBe(false);
		expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
		expect(calls[0]?.headers.get("user-agent")).toBe(`senpi (${platform()} ${release()}; ${arch()})`);
		expect(result.details).toMatchObject({
			schema: OPENAI_REMOTE_COMPACTION_SCHEMA,
			provider: "chatgpt-subscription",
			api: "openai-codex-responses",
			transport: "responses-v2",
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
					normalizeContext({ messages: convertToLlm(markedContext) }),
					new Set(["chatgpt-subscription"]),
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
		stubCodexV2Wire([], { type: "compaction", id: "cmp_stable_account", encrypted_content: "stable-account-state" });
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
		const calls: WireCall[] = [];
		const branch = codexBranch();
		stubCodexV2Wire(calls, {
			type: "compaction",
			id: "cmp_canonical_wire",
			encrypted_content: "canonical-wire-state",
		});
		const headerHookHarness = await createHarness({
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
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
				// The harness installs a faux transport for this api; compaction must reach the real one.
				{
					streamRunner: (model, context, options) =>
						streamCodex(model as typeof CODEX_MODEL, normalizeContext(context), options),
				},
			);
			if (!result) throw new Error("Expected Codex remote compaction result");

			expect(calls).toHaveLength(1);
			expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${tokenA}`);
			expect(calls[0]?.headers.get("chatgpt-account-id")).toBe(accountA);
			// The next turn runs the same header hook; its canonical origin is what replay compares.
			const turnHeaders = createOpenAiRemoteCompactionHeaders(
				CODEX_MODEL,
				{ apiKey: tokenA, headers: { authorization: `Bearer ${tokenB}`, "chatgpt-account-id": accountB } },
				"canonical-wire-session",
			);
			const wireOrigin = turnHeaders ? openAiRemoteCompactionOrigin(CODEX_MODEL, turnHeaders) : undefined;
			expect(wireOrigin).toBeDefined();
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
