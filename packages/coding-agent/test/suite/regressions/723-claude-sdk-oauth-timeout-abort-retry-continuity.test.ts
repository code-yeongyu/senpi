import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SDKUserMessage,
	type SdkQuery,
	type SdkQueryHandle,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { streamClaudeSdkOauth } from "../../../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

/**
 * Issue #723 mechanism M2: a stream-start-timeout abort must not make the
 * SAME turn's retry pay for the conversation again. Mid-conversation the retry
 * forks at the pre-turn assistant boundary, so the turn's user message is sent
 * exactly once per lineage. A first turn has no boundary to fork at, so it
 * re-seeds - but exactly once per attempt and byte-identically, which the
 * provider serves from prefix cache instead of re-billing.
 */

const SESSION_ID = "issue-723-retry-continuity";
const FLATTEN_MARKER = "<conversation_history>";
const FLATTEN_PREAMBLE = "The above is the conversation history so far";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function sdkMessage(value: unknown): SDKMessage {
	return value as SDKMessage;
}

/** Resident scripted query: answers each submission unless the turn is scripted to stall. */
class ResidentQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	readonly submitted: SDKUserMessage[] = [];
	readonly options: Options;
	closes = 0;
	private readonly stalls: () => boolean;
	private readonly onSubmit: (message: SDKUserMessage) => void;
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	constructor(
		prompt: AsyncIterable<SDKUserMessage>,
		options: Options,
		stalls: () => boolean,
		onSubmit: (message: SDKUserMessage) => void,
	) {
		this.options = options;
		this.stalls = stalls;
		this.onSubmit = onSubmit;
		void this.consume(prompt);
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		if (value) return Promise.resolve({ value, done: false });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	/** Clean interrupt receipt: nothing left queued, so the abort must not taint the lineage. */
	async interrupt(): Promise<unknown> {
		return { still_queued: [] };
	}

	close(): void {
		this.closes++;
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}

	private emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	private async consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
		for await (const message of prompt) {
			this.submitted.push(message);
			this.onSubmit(message);
			if (this.stalls()) continue; // stream-start timeout: accepted, never answered
			const uuid = message.uuid ?? `submitted-${this.submitted.length}`;
			const session = message.session_id;
			this.emit(sdkMessage({ ...message, uuid, session_id: session, isReplay: true }));
			this.emit(
				sdkMessage({
					type: "assistant",
					message: { id: `m-${uuid}`, type: "message", role: "assistant", content: [] },
					parent_tool_use_id: null,
					uuid: `assistant-${uuid}`,
					session_id: session,
				}),
			);
			this.emit(
				sdkMessage({
					type: "result",
					subtype: "success",
					result: `answer-${this.submitted.length}`,
					user_message_uuid: uuid,
					uuid: `result-${uuid}`,
					session_id: session,
				}),
			);
		}
	}
}

type Submission = { text: string; lineage: string; flattened: boolean };

/** Lineage identity as the SDK sees it: a fork mints a new branch, resume/seed do not. */
function lineageOf(options: Options): string {
	if (options.forkSession) return `fork:${String(options.resumeSessionAt)}`;
	return String(options.resume ?? options.sessionId ?? "unknown");
}

function textFrom(message: SDKUserMessage): string {
	const content = message.message.content;
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");
}

function residentBoundary(stalledSubmissions: ReadonlySet<number>) {
	const queries: ResidentQuery[] = [];
	const submissions: Submission[] = [];
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	const query: SdkQuery = ({ prompt, options = {} }) => {
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		const resident: ResidentQuery = new ResidentQuery(
			prompt,
			options,
			() => stalledSubmissions.has(submissions.length - 1),
			(message) => {
				const text = textFrom(message);
				submissions.push({
					text,
					lineage: lineageOf(resident.options),
					flattened: text.includes(FLATTEN_MARKER) || text.includes(FLATTEN_PREAMBLE),
				});
				for (const waiter of waiters.splice(0)) {
					if (submissions.length >= waiter.count) waiter.resolve();
					else waiters.push(waiter);
				}
			},
		);
		queries.push(resident);
		return resident;
	};
	overrideSdkBoundary({ query });
	overrideSessionRegistryBoundary({ queryFactory: query });
	return {
		queries,
		submissions,
		waitForSubmissions(count: number): Promise<void> {
			if (submissions.length >= count) return Promise.resolve();
			return new Promise((resolve) => waiters.push({ count, resolve }));
		},
	};
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
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

function continuityKinds(diagnostics: AssistantMessage["diagnostics"]): string[] {
	return (diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === "claude_sdk_oauth_session_continuity")
		.map((diagnostic) => String((diagnostic.details as { kind?: unknown } | undefined)?.kind));
}

function continuityReasons(diagnostics: AssistantMessage["diagnostics"]): string[] {
	return (diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === "claude_sdk_oauth_session_continuity")
		.map((diagnostic) => String((diagnostic.details as { reason?: unknown } | undefined)?.reason));
}

async function runTurn(context: Context, signal?: AbortSignal): Promise<AssistantMessage> {
	return await streamClaudeSdkOauth(model, context, {
		sessionId: SESSION_ID,
		streamKind: "main",
		...(signal ? { signal } : {}),
	}).result();
}

afterEach(() => {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	resetSessionRegistryBoundary();
	resetSdkBoundary();
});

describe("issue #723 claude-sdk-oauth stream-start-timeout retry continuity", () => {
	it("resumes the aborted turn's lineage instead of re-sending it", async () => {
		const { submissions, waitForSubmissions } = residentBoundary(new Set([1]));
		const user1 = { role: "user" as const, content: "first", timestamp: 1 };
		const user2 = { role: "user" as const, content: "second", timestamp: 3 };
		await runTurn({ messages: [user1] });

		const turn2: Context = { messages: [user1, assistant("answer-1", 2), user2] };
		const abort = new AbortController();
		const stalled = runTurn(turn2, abort.signal);
		await waitForSubmissions(2);
		abort.abort();
		expect((await stalled).stopReason).toBe("aborted");

		const retry = await runTurn(turn2);
		const turnSends = submissions.slice(1);

		// Sub-defect (a): the retry re-sends the delta only, never the flattened conversation.
		expect(retry.stopReason).toBe("stop");
		expect(turnSends.map((send) => send.text)).toEqual(turnSends.map(() => "second"));
		expect(turnSends.filter((send) => send.flattened)).toEqual([]);
		// Sub-defect (b): the retry stays on the established lineage.
		expect(continuityKinds(retry.diagnostics)).toEqual([expect.stringMatching(/^(?:delta|reattach|fork)$/)]);
		// Sub-defect (c): the aborted attempt already appended the delta to its
		// lineage, so re-appending it there bills the turn twice and duplicates the
		// user message. The retry must rewind (fork) or otherwise not re-append.
		const perLineage = new Map<string, number>();
		for (const send of turnSends) perLineage.set(send.lineage, (perLineage.get(send.lineage) ?? 0) + 1);
		expect({ maxSendsPerLineage: Math.max(...perLineage.values()) }).toEqual({ maxSendsPerLineage: 1 });
	}, 10_000);

	it("re-seeds a stalled first turn byte-identically instead of storming", async () => {
		const { submissions, waitForSubmissions } = residentBoundary(new Set([0]));
		const turn1: Context = { messages: [{ role: "user", content: "first", timestamp: 1 }] };

		const abort = new AbortController();
		const stalled = runTurn(turn1, abort.signal);
		await waitForSubmissions(1);
		abort.abort();
		expect((await stalled).stopReason).toBe("aborted");

		const retry = await runTurn(turn1);
		const coldSeeds = submissions.filter((send) => send.flattened);

		// Sub-defect (d): a first turn has no assistant boundary to fork at, so the
		// retry must re-seed - but exactly ONCE per attempt (never a storm), and
		// byte-identically, so the provider serves the repeat from prefix cache
		// instead of re-billing the write.
		expect(retry.stopReason).toBe("stop");
		expect({ coldSeedSends: coldSeeds.length, attempts: submissions.length }).toEqual({
			coldSeedSends: 2,
			attempts: 2,
		});
		expect(new Set(coldSeeds.map((send) => send.text)).size).toBe(1);
		// Sub-defect (e): the retry is attributed to the same-turn timeout retry, not
		// to a fresh unexplained bootstrap.
		expect(continuityKinds(retry.diagnostics)).toEqual(["flatten"]);
		expect(continuityReasons(retry.diagnostics)).toEqual(["timeout_retry"]);
	}, 10_000);
});
