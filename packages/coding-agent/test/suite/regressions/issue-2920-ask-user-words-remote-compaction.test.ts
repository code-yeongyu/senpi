// senpi#2920 round 2: the user message rebuilt from a tool result's `details.userWords` belongs to
// the same remote-compaction checkpoint as that tool result, so an OpenAI remote replay still
// proves its boundary and replaces the words along with the rest of the compacted history.

import { zstdDecompressSync } from "node:zlib";
import { type AssistantMessage, convertResponsesMessages, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import {
	markOpenAiRemoteReplayBoundary,
	rewriteOpenAiPayloadWithRemoteCompaction,
	runOpenAiRemoteCompaction,
} from "../../../src/core/extensions/builtin/compaction/openai-remote.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { buildSessionContext, type SessionEntry, type SessionMessageEntry } from "../../../src/core/session-manager.ts";

const MODEL = {
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
const WORDS = "QA2920 keep the migration reversible";
const LABEL = "The user's comment for question call_ask";
const USAGE = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: string, parentId: string | null, message: SessionMessageEntry["message"]): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(1_775_000_000_000 + id.length).toISOString(), message };
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		content,
		usage: USAGE,
		stopReason,
		timestamp: 2,
	};
}

function answeredBranch(trailing: boolean): SessionEntry[] {
	const branch: SessionEntry[] = [
		{
			type: "model_change",
			id: "model",
			parentId: null,
			timestamp: new Date(1_775_000_000_000).toISOString(),
			provider: MODEL.provider,
			modelId: MODEL.id,
		},
		entry("u1", "model", { role: "user", content: [{ type: "text", text: "Set up auth." }], timestamp: 1 }),
		entry(
			"a1",
			"u1",
			assistant([{ type: "toolCall", id: "call_ask", name: "ask_user_question", arguments: {} }], "toolUse"),
		),
		entry("t1", "a1", {
			role: "toolResult",
			toolCallId: "call_ask",
			toolName: "ask_user_question",
			content: [{ type: "text", text: `The user responded: (see [${LABEL}] below)` }],
			details: { status: "comment-submitted", userWords: [{ label: LABEL, text: WORDS }] },
			isError: false,
			timestamp: 3,
		}),
	];
	if (trailing) branch.push(entry("a2", "t1", assistant([{ type: "text", text: "Understood." }], "stop")));
	return branch;
}

function stubCompactWire(): void {
	const compaction = { type: "compaction", id: "cmp_2920", encrypted_content: "encrypted-2920" };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = init?.body;
			if (body && typeof body !== "string") zstdDecompressSync(body as Uint8Array);
			const events = [
				{ type: "response.output_item.added", output_index: 0, item: compaction },
				{ type: "response.output_item.done", output_index: 0, item: compaction },
				{
					type: "response.completed",
					response: {
						id: "r",
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

function token(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_2920" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

async function checkpointed(branch: SessionEntry[], firstKeptEntryId: string): Promise<SessionEntry[]> {
	stubCompactWire();
	const result = await runOpenAiRemoteCompaction(
		{
			model: MODEL,
			serviceTier: undefined,
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: token() }) },
			sessionManager: { getSessionId: () => "issue-2920-remote" },
			getSystemPrompt: () => "You are Senpi.",
		},
		{
			type: "session_before_compact",
			reason: "threshold",
			willRetry: true,
			requestId: "issue-2920-remote",
			preparation: {
				firstKeptEntryId,
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1234,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: DEFAULT_COMPACTION_SETTINGS,
			},
			branchEntries: branch,
			signal: new AbortController().signal,
		},
	);
	if (!result) throw new Error("remote compaction did not run");
	const last = branch.at(-1)?.id ?? null;
	return [
		...branch,
		{
			type: "compaction",
			id: "remote-checkpoint",
			parentId: last,
			timestamp: new Date(1_775_000_002_000).toISOString(),
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			details: result.details,
			fromHook: true,
		},
	];
}

function replay(branchEntries: SessionEntry[]): { input: unknown[] | undefined; actions: string[] } {
	const marked = markOpenAiRemoteReplayBoundary(
		[
			...buildSessionContext(branchEntries).messages,
			{ role: "user", content: [{ type: "text", text: "Continue after compaction." }], timestamp: 9 },
		],
		{ model: MODEL, branchEntries },
	);
	const actions: string[] = [];
	const payload = {
		model: MODEL.id,
		input: convertResponsesMessages(
			MODEL,
			normalizeContext({ messages: convertToLlm(marked) }),
			new Set([MODEL.provider]),
			{
				includeSystemPrompt: false,
				preserveTextSignatures: true,
			},
		),
		stream: true,
	};
	const compaction = branchEntries.find((candidate) => candidate.type === "compaction");
	const origin = compaction?.type === "compaction" ? (compaction.details as { origin?: never }).origin : undefined;
	const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(
		payload,
		{ model: MODEL, branchEntries, origin },
		(event) => actions.push(`${event.action}${"reason" in event && event.reason ? `:${event.reason}` : ""}`),
	) as { input?: unknown[] } | undefined;
	return { input: rewritten?.input, actions };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("senpi#2920 answer words inside an OpenAI remote-compaction checkpoint", () => {
	it("a checkpoint holding an answer and a later reply still replays", async () => {
		const { input, actions } = replay(await checkpointed(answeredBranch(true), "a1"));
		expect(actions).toEqual(["remote_payload_rewritten"]);
		expect(JSON.stringify(input)).not.toContain(WORDS);
		expect(input).toContainEqual({ type: "compaction", id: "cmp_2920", encrypted_content: "encrypted-2920" });
	});

	it("a checkpoint that ends on the answer does not send its words again", async () => {
		const { input, actions } = replay(await checkpointed(answeredBranch(false), "a1"));
		expect(actions).toEqual(["remote_payload_rewritten"]);
		expect(JSON.stringify(input)).not.toContain(WORDS);
		expect(input).toContainEqual({
			role: "user",
			content: [{ type: "input_text", text: "Continue after compaction." }],
		});
	});
});
