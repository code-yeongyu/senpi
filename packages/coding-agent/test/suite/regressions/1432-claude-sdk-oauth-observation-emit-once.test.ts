/**
 * Issue #1432 (observation emit-once): a claude-sdk-oauth turn that fails over
 * from one account to another attempts two accounts, but continuity
 * observability promises exactly one observation per completed turn - a
 * discarded attempt must emit nothing (session-observability.ts). The first
 * attempt used to emit its staged observation from a finally block even when it
 * was discarded, so a failover turn produced two observations (the discarded
 * delta plus the retained fork). This pins the one-observation contract.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type {
	AccountSlot,
	ClaudeSdkOauthCredential,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/auth-lane.ts";
import type {
	Options,
	SDKMessage,
	SDKUserMessage,
	SdkQuery,
	SdkQueryHandle,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import type { ContinuityObservation } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { streamClaudeSdkOauth } from "../../../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

const SESSION_ID = "issue-1432-emit-once";
const ACCOUNT_PRIMARY = "primary";
const ACCOUNT_SECONDARY = "secondary";
const ACCESS_PRIMARY = "access-primary";

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

type AttemptOutcome = "success" | "rate-limit";
type QueryRecord = { account: string; options: Options; submitted: SDKUserMessage[] };

function slot(name: string, access: string): AccountSlot {
	return { name, access, refresh: `r-${name}`, expires: Date.now() + 3_600_000, source: "login" };
}

// Resident scripted query: answers each submission with a replay echo, then either
// an assistant + success result or - when scripted - a retryable rate-limit result
// BEFORE any assistant or stream_event delta.
class ScriptedResidentQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	readonly submitted: SDKUserMessage[] = [];
	private readonly account: string;
	private readonly script: (submission: number) => AttemptOutcome;
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	constructor(prompt: AsyncIterable<SDKUserMessage>, account: string, script: (submission: number) => AttemptOutcome) {
		this.account = account;
		this.script = script;
		void this.consume(prompt);
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		return value ? Promise.resolve({ value, done: false }) : new Promise((resolve) => this.readers.push(resolve));
	}

	async interrupt(): Promise<unknown> {
		return { still_queued: [] };
	}

	close(): void {
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
			const uuid = message.uuid ?? `submitted-${this.submitted.length}`;
			this.emit(sdkMessage({ ...message, uuid, isReplay: true }));
			if (this.script(this.submitted.length) === "rate-limit") {
				this.emit(
					sdkMessage({
						type: "result",
						subtype: "error_during_execution",
						errors: ["rate_limit"],
						user_message_uuid: uuid,
						session_id: message.session_id,
					}),
				);
				continue;
			}
			this.emit(
				sdkMessage({
					type: "assistant",
					message: { id: `assistant-${uuid}`, type: "message", role: "assistant", content: [] },
					parent_tool_use_id: null,
					uuid: `assistant-turn-${this.submitted.length}`,
					session_id: message.session_id,
				}),
			);
			this.emit(
				sdkMessage({
					type: "result",
					subtype: "success",
					result: `${this.account}-answer-${this.submitted.length}`,
					user_message_uuid: uuid,
					session_id: message.session_id,
				}),
			);
		}
	}
}

// Fake SDK boundary keyed by the OAuth token each attempt's env carries.
function residentBoundary(scriptFor: (account: string, submission: number) => AttemptOutcome): QueryRecord[] {
	const queries: QueryRecord[] = [];
	const query: SdkQuery = ({ prompt, options = {} }) => {
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		const account = options.env?.CLAUDE_CODE_OAUTH_TOKEN === ACCESS_PRIMARY ? ACCOUNT_PRIMARY : ACCOUNT_SECONDARY;
		const handle = new ScriptedResidentQuery(prompt, account, (submission) => scriptFor(account, submission));
		queries.push({ account, options, submitted: handle.submitted });
		return handle;
	};
	overrideSdkBoundary({ query });
	overrideSessionRegistryBoundary({ queryFactory: query });
	return queries;
}

const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

// Two-account managed OAuth pool on the oauth-slots lane, pinned to primary.
async function configureTwoAccountPool(): Promise<void> {
	const slots = [slot(ACCOUNT_PRIMARY, ACCESS_PRIMARY), slot(ACCOUNT_SECONDARY, "access-secondary")];
	const store = new InMemoryCredentialStore();
	await store.modify("claude-sdk-oauth", async () => ({
		...slots.reduce<ClaudeSdkOauthCredential>(
			(credential, entry) => addAccount(credential, entry),
			emptyCredential(),
		),
		pinned: ACCOUNT_PRIMARY,
	}));
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-1432-failover-"));
	temporaryDirectories.push(agentDir);
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ claudeSdkOauthProvider: { tokenInjection: "oauth-slots" } }),
	);
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin" }),
		getAgentDir: () => agentDir,
	});
}

function assistant(text: string, timestamp: number): AssistantMessage {
	// Continuity hashing ignores assistant messages, so only the flatten envelope reads this.
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp } as AssistantMessage;
}

function runTurn(context: Context): Promise<AssistantMessage> {
	return streamClaudeSdkOauth(model, context, { sessionId: SESSION_ID, streamKind: "main" }).result();
}

afterEach(() => {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetAuthLaneBoundary();
	resetContinuityObservabilityBoundary();
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("issue #1432 claude-sdk-oauth failover emits one observation", () => {
	it("emits exactly one continuity observation for a failover turn, not one per attempt", async () => {
		await configureTwoAccountPool();
		const observations: ContinuityObservation[] = [];
		overrideContinuityObservabilityBoundary({ emit: (observation) => observations.push(observation) });
		const queries = residentBoundary((account, submission) =>
			account === ACCOUNT_PRIMARY && submission === 2 ? "rate-limit" : "success",
		);

		const user1 = { role: "user" as const, content: "first", timestamp: 1 };
		const user2 = { role: "user" as const, content: "second", timestamp: 3 };
		await runTurn({ messages: [user1] });
		// Turn 1 emitted its own observation; only turn 2 is under test here.
		observations.length = 0;

		const turn2 = await runTurn({ messages: [user1, assistant("first answer", 2), user2] });

		// The turn still completes on the failover account and forks the lineage.
		expect(turn2.content).toEqual([{ type: "text", text: `${ACCOUNT_SECONDARY}-answer-1` }]);
		expect(queries).toHaveLength(2);
		// Exactly one observation for the turn: the discarded first attempt stays
		// silent, so the retained fork is the sole observation (not delta + fork).
		expect(observations).toHaveLength(1);
		expect(observations[0]).toMatchObject({ kind: "fork", reason: "timeout_retry" });
		expect(observations.some((observation) => observation.kind === "delta")).toBe(false);
	}, 10_000);
});
