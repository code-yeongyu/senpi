import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKUserMessage,
	type SdkQuery,
	type SessionMessage,
} from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { earlierVerifiedCheckpoint } from "../src/core/extensions/builtin/anthropic-subscription/session-checkpoint-recovery.ts";
import {
	closeSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { streamAnthropicSubscription } from "../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { ScriptedResidentQuery, sdkMessage, type TurnScript } from "./helpers/anthropic-subscription-scripted-sdk.ts";

/**
 * senpi#1973: when Claude Code rejects a fork point ("No message found with message.uuid"),
 * the resident lane forks at the newest EARLIER mapped boundary the SDK transcript still holds
 * instead of re-sending the whole conversation. Foreign transcripts, subagent-only candidates
 * and the config-dir lane stay fail-closed.
 */

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const SESSION_ID = "issue-1973-checkpoint-recovery";

const answer: TurnScript = (sessionId, userUuid) => [
	sdkMessage({
		type: "assistant",
		message: { id: `message-${userUuid}`, type: "message", role: "assistant", content: [] },
		parent_tool_use_id: null,
		uuid: `assistant-${userUuid}`,
		session_id: sessionId,
	}),
	sdkMessage({
		type: "result",
		subtype: "success",
		result: "ok",
		user_message_uuid: userUuid,
		uuid: `result-${userUuid}`,
		session_id: sessionId,
	}),
];

class ResidentQuery extends ScriptedResidentQuery {
	readonly options: Options;
	readonly rejection: Error | undefined;

	constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options, rejection: Error | undefined) {
		super(prompt, answer);
		this.options = options;
		this.rejection = rejection;
	}

	async initializationResult(): Promise<Record<string, never>> {
		if (this.rejection) throw this.rejection;
		return {};
	}
}

function residentSdk(rejectedUuid: () => string | undefined, transcript: () => SessionMessage[]) {
	const queries: ResidentQuery[] = [];
	const query: SdkQuery = ({ prompt, options = {} }) => {
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		const rejected = rejectedUuid();
		const rejection =
			rejected !== undefined && options.resumeSessionAt === rejected
				? new Error(`No message found with message.uuid of: ${rejected}`)
				: undefined;
		const resident = new ResidentQuery(prompt, options, rejection);
		queries.push(resident);
		return resident;
	};
	overrideSdkBoundary({ query, getSessionMessages: async () => transcript() });
	overrideSessionRegistryBoundary({ queryFactory: query });
	return queries;
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

const user = (content: string, timestamp: number) => ({ role: "user" as const, content, timestamp });
const turnFour = [
	user("one", 1),
	assistant("a1", 2),
	user("two", 3),
	assistant("a2", 4),
	user("three", 5),
	assistant("a3", 6),
	user("four", 7),
];

function submittedText(query: ResidentQuery | undefined): string {
	const content = query?.submitted[0]?.message.content ?? [];
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Four committed turns (boundaries 1-4), then a rollback to the third user turn, which forks at boundary 2. */
async function rollbackAfterRejectedBoundary(transcriptFor: (sdkSessionId: string, live: string) => SessionMessage[]) {
	let rejected: string | undefined;
	let transcript: SessionMessage[] = [];
	const queries = residentSdk(
		() => rejected,
		() => transcript,
	);
	const options = { sessionId: SESSION_ID, streamKind: "main" as const };
	for (const length of [1, 3, 5, 7]) {
		await streamAnthropicSubscription(model, { messages: turnFour.slice(0, length) }, options).result();
	}
	const entry = getSession(SESSION_ID);
	const live = entry?.assistantUuidByIndex.get(1);
	rejected = entry?.assistantUuidByIndex.get(2);
	if (!entry || !live || !rejected) throw new Error("fixture did not map the assistant boundaries");
	transcript = transcriptFor(entry.sdkSessionId, live);
	const result = await streamAnthropicSubscription(model, { messages: turnFour.slice(0, 5) }, options).result();
	return { queries, result, live, rejected };
}

function topLevelAssistant(sessionId: string, uuid: string, parentToolUseId: string | null = null): SessionMessage {
	return { type: "assistant", uuid, session_id: sessionId, parent_tool_use_id: parentToolUseId } as SessionMessage;
}

afterEach(() => {
	closeSession(SESSION_ID, "test_cleanup");
	resetSessionRegistryBoundary();
	resetSdkBoundary();
});

describe("issue #1973: a rejected fork point recovers at an earlier verified boundary", () => {
	it("forks at the earlier boundary the transcript still holds and re-sends only its tail", async () => {
		const { queries, result, live, rejected } = await rollbackAfterRejectedBoundary((sdkSessionId, uuid) => [
			topLevelAssistant(sdkSessionId, uuid),
		]);

		const forks = queries.slice(1);
		expect(forks.map((query) => query.options.resumeSessionAt)).toEqual([rejected, live]);
		expect(submittedText(forks[1])).toContain("two");
		expect(submittedText(forks[1])).not.toContain("one");
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ type: "claude_sdk_oauth_resume_fallback" }),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "claude_sdk_oauth_session_continuity",
				details: expect.objectContaining({ reason: "history_rolled_back" }),
			}),
		);
	});

	it("cold-seeds loudly when the transcript belongs to another SDK session", async () => {
		const { queries, result } = await rollbackAfterRejectedBoundary((_sdkSessionId, uuid) => [
			topLevelAssistant("another-sdk-session", uuid),
		]);

		expect(queries.at(-1)?.options.resume).toBeUndefined();
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "claude_sdk_oauth_resume_fallback" }));
	});

	it("never forks at a candidate the transcript only holds as a subagent message", async () => {
		const { queries, result } = await rollbackAfterRejectedBoundary((sdkSessionId, uuid) => [
			topLevelAssistant(sdkSessionId, uuid, "tool-use-1"),
		]);

		expect(queries.at(-1)?.options.resume).toBeUndefined();
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "claude_sdk_oauth_resume_fallback" }));
	});

	it("does not read a transcript across config-dir account roots", async () => {
		let reads = 0;
		overrideSdkBoundary({
			getSessionMessages: async () => {
				reads += 1;
				return [];
			},
		});
		const recovered = await earlierVerifiedCheckpoint({
			binding: {
				senpiSessionId: SESSION_ID,
				sdkSessionId: "sdk-1",
				sentCount: 3,
				sentHashes: ["h1", "h2", "h3"],
				lastAssistantUuid: "a3",
				assistantUuidByIndex: [
					[1, "a1"],
					[3, "a3"],
				],
				accountName: "primary",
				modelId: model.id,
				systemPromptHash: "prompt",
				toolsetHash: "tools",
			},
			currentHashes: ["h1", "h2", "h3"],
			cwd: "/workspace",
			authLane: "config-dir",
		});

		expect(recovered).toBeUndefined();
		expect(reads).toBe(0);
	});
});
