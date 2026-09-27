/**
 * oh-my-openagent#8762: a resident Claude Code process keeps the CLAUDE_CODE_OAUTH_TOKEN it was
 * spawned with. When the stored token rotated (this attempt's own prepareSlot refresh, or another
 * process's refresh of the shared slot), the lane reused that process as `delta`. The API rejected
 * the pre-rotation token with "401 OAuth access token has been revoked", and the lane stamped a
 * non-expiring `auth_error` on the slot that already held the fresh token, so every process failed
 * until /login. Pinned here: a rotated token reattaches the same SDK session in a new process that
 * carries the current token, an unchanged token keeps the live process, and a 401 for a token the
 * slot no longer holds (rotated while the request was in flight) does not block the account.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, CredentialStore, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { selectAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import {
	EXPIRING_WITHIN_MS,
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import {
	ClassifiedSdkError,
	runFailover,
} from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import type {
	Options,
	SDKMessage,
	SDKUserMessage,
	SdkQuery,
	SdkQueryHandle,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	type ContinuityDecisionInput,
	decideNativeContinuity,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-continuity.ts";
import type { ContinuityObservation } from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import {
	closeSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";

const PROVIDER = "anthropic-subscription";
const SESSION_ID = "issue-8762-rotated-token";
const REVOKED = "Failed to authenticate. API Error: 401 OAuth access token has been revoked. (authentication_failed)";
const MINUTE = 60_000;
const START = Date.parse("2026-09-27T00:00:00.000Z");
const FINGERPRINT = { systemPromptHash: "prompt", toolsetHash: "tools" };

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: PROVIDER,
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

/** Token endpoint double: redeeming the refresh token revokes the access token it replaces. */
class FakeTokenServer {
	private valid = new Set(["access-1"]);
	private issued = 1;
	beforeNextRequest: (() => Promise<void>) | undefined;

	accepts(token: string | undefined): boolean {
		return token !== undefined && this.valid.has(token);
	}

	rotate(): string {
		this.issued += 1;
		const access = `access-${this.issued}`;
		this.valid = new Set([access]);
		return access;
	}
}

class TokenBoundQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	readonly submitted: SDKUserMessage[] = [];
	private readonly token: string | undefined;
	private readonly server: FakeTokenServer;
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	constructor(prompt: AsyncIterable<SDKUserMessage>, token: string | undefined, server: FakeTokenServer) {
		this.token = token;
		this.server = server;
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
			const session_id = message.session_id;
			this.emit(sdkMessage({ ...message, uuid, isReplay: true }));
			const beforeRequest = this.server.beforeNextRequest;
			this.server.beforeNextRequest = undefined;
			await beforeRequest?.();
			if (!this.server.accepts(this.token)) {
				this.emit(
					sdkMessage({
						type: "result",
						subtype: "error_during_execution",
						errors: [REVOKED],
						user_message_uuid: uuid,
						session_id,
					}),
				);
				continue;
			}
			this.emit(
				sdkMessage({
					type: "assistant",
					message: { id: `assistant-${uuid}`, type: "message", role: "assistant", content: [] },
					parent_tool_use_id: null,
					uuid: `assistant-${uuid}`,
					session_id,
				}),
			);
			this.emit(
				sdkMessage({
					type: "result",
					subtype: "success",
					result: `${this.token}-answer`,
					user_message_uuid: uuid,
					session_id,
				}),
			);
		}
	}
}

type Spawn = { token: string | undefined; options: Options; submitted: SDKUserMessage[] };

const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

function loginSlot(expires: number): AccountSlot {
	return { name: "default", access: "access-1", refresh: "refresh-1", expires, source: "login" };
}

async function storeWith(slot: AccountSlot): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () => addAccount(emptyCredential(), slot));
	return store;
}

async function patchStoredSlot(store: CredentialStore, patch: Partial<AccountSlot>): Promise<void> {
	await store.modify(PROVIDER, async (current) => {
		const credential = current as AnthropicSubscriptionCredential;
		return { ...credential, accounts: credential.accounts?.map((slot) => ({ ...slot, ...patch })) };
	});
}

async function storedSlot(store: CredentialStore) {
	const credential = (await store.read(PROVIDER)) as AnthropicSubscriptionCredential | undefined;
	return credential?.accounts?.find((slot) => slot.name === "default");
}

async function configureLane(expiresInMs: number) {
	const server = new FakeTokenServer();
	const clock = { now: START };
	const refreshes: string[] = [];
	const store = await storeWith(loginSlot(START + expiresInMs));
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-8762-"));
	temporaryDirectories.push(agentDir);
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ anthropicSubscriptionProvider: { tokenInjection: "oauth-slots" } }),
	);
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin" }),
		getAgentDir: () => agentDir,
		now: () => clock.now,
		refresher: async (refresh) => {
			refreshes.push(refresh);
			const access = server.rotate();
			return { access, refresh: `refresh-for-${access}`, expires: clock.now + 480 * MINUTE };
		},
	});
	const spawns: Spawn[] = [];
	const query: SdkQuery = ({ prompt, options = {} }) => {
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		const token = options.env?.CLAUDE_CODE_OAUTH_TOKEN;
		const handle = new TokenBoundQuery(prompt, token, server);
		spawns.push({ token, options, submitted: handle.submitted });
		return handle;
	};
	overrideSdkBoundary({ query });
	overrideSessionRegistryBoundary({ queryFactory: query });
	const observations: ContinuityObservation[] = [];
	overrideContinuityObservabilityBoundary({ emit: (observation) => observations.push(observation), log: () => {} });
	return { server, clock, refreshes, store, spawns, observations };
}

async function refreshInAnotherProcess(server: FakeTokenServer, store: CredentialStore): Promise<string> {
	const access = server.rotate();
	await patchStoredSlot(store, { access, expires: START + 960 * MINUTE });
	return access;
}

function user(content: string, timestamp: number) {
	return { role: "user" as const, content, timestamp };
}

function answered(text: string, timestamp: number): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp } as AssistantMessage;
}

function textFrom(message: SDKUserMessage | undefined): string {
	const content = message?.message.content ?? "";
	return typeof content === "string"
		? content
		: content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function runTurn(context: Context): Promise<AssistantMessage> {
	return streamAnthropicSubscription(model, context, { sessionId: SESSION_ID, streamKind: "main" }).result();
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

describe("oh-my-openagent#8762 resident session across an OAuth token rotation", () => {
	it("reattaches with the token this attempt's own refresh just stored", async () => {
		const lane = await configureLane(30 * MINUTE);
		const first = user("first", 1);
		await runTurn({ messages: [first] });
		const boundSdkSessionId = getSession(SESSION_ID)?.sdkSessionId;
		expect(typeof boundSdkSessionId).toBe("string");

		lane.clock.now = START + 30 * MINUTE - EXPIRING_WITHIN_MS;
		const turn2 = await runTurn({ messages: [first, answered("access-1-answer", 2), user("second", 3)] });

		expect(lane.refreshes).toEqual(["refresh-1"]);
		expect(turn2.errorMessage).toBeUndefined();
		expect(turn2.content).toEqual([{ type: "text", text: "access-2-answer" }]);
		expect(lane.spawns.map((spawn) => spawn.token)).toEqual(["access-1", "access-2"]);
		expect(lane.spawns[1]?.options).toMatchObject({ resume: boundSdkSessionId });
		expect(lane.spawns[1]?.options.forkSession).toBeUndefined();
		expect(textFrom(lane.spawns[1]?.submitted[0])).toBe("second");
		expect(await storedSlot(lane.store)).toMatchObject({ access: "access-2" });
		expect((await storedSlot(lane.store))?.blockReason).toBeUndefined();
		expect(lane.observations.at(-1)).toMatchObject({ kind: "fork", reason: "bound_account_token_expiring" });
	}, 10_000);

	it("keeps the live process for an unchanged token and reattaches after another process rotated it", async () => {
		const lane = await configureLane(480 * MINUTE);
		const first = user("first", 1);
		const second = user("second", 3);
		await runTurn({ messages: [first] });
		const boundSdkSessionId = getSession(SESSION_ID)?.sdkSessionId;
		lane.clock.now = START + MINUTE;
		await runTurn({ messages: [first, answered("access-1-answer", 2), second] });
		expect(lane.spawns).toHaveLength(1);

		const rotated = await refreshInAnotherProcess(lane.server, lane.store);
		lane.clock.now = START + 2 * MINUTE;
		const turn3 = await runTurn({
			messages: [first, answered("access-1-answer", 2), second, answered("access-1-answer", 4), user("third", 5)],
		});

		expect(lane.refreshes).toEqual([]);
		expect(turn3.errorMessage).toBeUndefined();
		expect(turn3.content).toEqual([{ type: "text", text: `${rotated}-answer` }]);
		expect(lane.spawns.map((spawn) => spawn.token)).toEqual(["access-1", rotated]);
		expect(lane.spawns[1]?.options).toMatchObject({ resume: boundSdkSessionId });
		expect(textFrom(lane.spawns[1]?.submitted[0])).toBe("third");
		expect((await storedSlot(lane.store))?.blockReason).toBeUndefined();
	}, 10_000);

	it("does not block the account for a 401 on a token another process rotated mid-request", async () => {
		const lane = await configureLane(480 * MINUTE);
		const first = user("first", 1);
		const secondTurn = [first, answered("access-1-answer", 2), user("second", 3)];
		await runTurn({ messages: [first] });
		lane.server.beforeNextRequest = async () => {
			await refreshInAnotherProcess(lane.server, lane.store);
		};
		lane.clock.now = START + MINUTE;
		const rejected = await runTurn({ messages: secondTurn });

		expect(rejected.errorMessage).toContain("401 OAuth access token has been revoked");
		expect(await storedSlot(lane.store)).toMatchObject({ access: "access-2" });
		expect((await storedSlot(lane.store))?.blockReason).toBeUndefined();

		lane.clock.now = START + 2 * MINUTE;
		const retried = await runTurn({ messages: secondTurn });
		expect(retried.errorMessage).toBeUndefined();
		expect(retried.content).toEqual([{ type: "text", text: "access-2-answer" }]);
		expect(lane.spawns.map((spawn) => spawn.token)).toEqual(["access-1", "access-2"]);
	}, 10_000);
});

describe("oh-my-openagent#8762 continuity decision for a live session whose token rotated", () => {
	function rotated(entry: Partial<NonNullable<ContinuityDecisionInput["entry"]>>): ContinuityDecisionInput {
		return {
			entry: {
				sdkSessionId: "sdk-1",
				accountName: "default",
				modelId: "claude-test",
				...FINGERPRINT,
				sentCount: 2,
				sentHashes: ["h1", "h2"],
				lastAssistantUuid: "uuid-a2",
				assistantUuidByIndex: new Map([
					[1, "uuid-a1"],
					[2, "uuid-a2"],
				]),
				pendingForkReason: null,
				...entry,
			},
			binding: undefined,
			currentHashes: ["h1", "h2", "h3"],
			accountName: "default",
			modelId: "claude-test",
			fingerprint: FINGERPRINT,
			transcriptAvailable: true,
			crossAccountResumeSupported: true,
			credentialRotated: true,
		};
	}

	it("reattaches a confirmed session so the new process carries the current token", () => {
		expect(decideNativeContinuity(rotated({ sdkSessionIdConfirmed: true }))).toEqual({
			kind: "reattach",
			sdkSessionId: "sdk-1",
			from: 2,
			reason: "bound_account_token_expiring",
		});
	});

	it("cold-seeds instead of resuming a session id the SDK never acknowledged", () => {
		expect(decideNativeContinuity(rotated({ sdkSessionIdConfirmed: false }))).toEqual({
			kind: "flatten",
			reason: "session_unconfirmed",
		});
	});

	it("leaves a pending divergence ahead of the token branch", () => {
		expect(decideNativeContinuity(rotated({ pendingForkReason: "compaction" }))).toEqual({
			kind: "fork",
			sdkSessionId: "sdk-1",
			atUuid: "uuid-a1",
			from: 1,
			reason: "tainted_compaction",
		});
	});
});

describe("oh-my-openagent#8762 auth block for a token the slot no longer holds", () => {
	function failover(store: CredentialStore, account: AccountSlot, attempt: (slot: AccountSlot) => Promise<void>) {
		return runFailover({
			accounts: [account],
			selectFn: (pool) => selectAccount(pool, { sessionId: SESSION_ID, now: START }),
			runAttempt: async (slot) => {
				await attempt(slot);
				throw new Error(REVOKED);
			},
			classify: classifySdkError,
			store,
			providerId: PROVIDER,
			now: () => START,
		});
	}

	it("does not block the stored token when a concurrent refresh rewrote the shared slot object mid-request", async () => {
		const shared = loginSlot(START + 480 * MINUTE);
		const store = await storeWith({ ...shared });
		const stream = failover(store, shared, async () => {
			Object.assign(shared, { access: "access-2" });
			await patchStoredSlot(store, { access: "access-2" });
		});

		await expect(stream.next()).rejects.toBeInstanceOf(ClassifiedSdkError);
		expect(await storedSlot(store)).toMatchObject({ access: "access-2" });
		expect((await storedSlot(store))?.blockReason).toBeUndefined();
	});

	it("still blocks the stored token when the token this attempt refreshed to is the one rejected", async () => {
		const store = await storeWith(loginSlot(START + 480 * MINUTE));
		const stream = failover(store, loginSlot(START + 480 * MINUTE), async (slot) => {
			Object.assign(slot, { access: "access-2" });
			await patchStoredSlot(store, { access: "access-2" });
		});

		await expect(stream.next()).rejects.toBeInstanceOf(ClassifiedSdkError);
		expect(await storedSlot(store)).toMatchObject({ access: "access-2", blockReason: "auth_error" });
	});
});
