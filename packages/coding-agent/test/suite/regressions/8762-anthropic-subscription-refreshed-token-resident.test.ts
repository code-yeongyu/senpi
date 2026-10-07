/**
 * oh-my-openagent#8762: a refresh revokes the access token a resident Claude Code subprocess was
 * spawned with. The next turn used to be sent as a delta to that subprocess,
 * which answered 401 "OAuth access token has been revoked"; failover then
 * stamped `auth_error` on a slot whose stored token was valid, so the account
 * stayed "blocked until re-login". Pinned here: the turn resumes the same SDK
 * lineage in a subprocess carrying the current token, and nothing is blocked.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AnthropicSubscriptionCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
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

const SESSION_ID = "refreshed-token-resident";
const PROVIDER = "anthropic-subscription";
const REVOKED = "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";

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

const revoked = new Set<string>();

class TokenBoundQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];
	private readonly token: string;
	private submissions = 0;

	constructor(prompt: AsyncIterable<SDKUserMessage>, token: string) {
		this.token = token;
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

	private emit(value: unknown): void {
		const message = value as SDKMessage;
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	private async consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
		for await (const message of prompt) {
			this.submissions += 1;
			const uuid = message.uuid ?? `submitted-${this.token}-${this.submissions}`;
			const session_id = message.session_id;
			this.emit({ ...message, uuid, isReplay: true });
			if (revoked.has(this.token)) {
				this.emit({
					type: "result",
					subtype: "error_during_execution",
					errors: [REVOKED],
					user_message_uuid: uuid,
					session_id,
				});
				continue;
			}
			const answer = `${this.token}-answer-${this.submissions}`;
			this.emit({
				type: "assistant",
				message: { id: `assistant-${uuid}`, type: "message", role: "assistant", content: [] },
				parent_tool_use_id: null,
				uuid: `assistant-${answer}`,
				session_id,
			});
			this.emit({ type: "result", subtype: "success", result: answer, user_message_uuid: uuid, session_id });
		}
	}
}

function tokenBoundBoundary(): Array<{ token: string; options: Options }> {
	const spawned: Array<{ token: string; options: Options }> = [];
	const query: SdkQuery = ({ prompt, options = {} }) => {
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		const token = options.env?.CLAUDE_CODE_OAUTH_TOKEN ?? "";
		spawned.push({ token, options });
		return new TokenBoundQuery(prompt, token);
	};
	overrideSdkBoundary({ query });
	overrideSessionRegistryBoundary({ queryFactory: query });
	return spawned;
}

const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

async function configureSingleAccount(): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () =>
		addAccount(emptyCredential(), {
			name: "default",
			access: "access-1",
			refresh: "refresh-1",
			expires: Date.now() + 3_600_000,
			source: "login",
		}),
	);
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-refreshed-token-"));
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
	return store;
}

async function refreshElsewhere(store: InMemoryCredentialStore): Promise<void> {
	await store.modify(PROVIDER, async (current) => {
		const credential = current as AnthropicSubscriptionCredential;
		const accounts = credential.accounts?.map((slot) => ({ ...slot, access: "access-2", refresh: "refresh-2" }));
		return { ...credential, accounts };
	});
	revoked.add("access-1");
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp } as AssistantMessage;
}

afterEach(() => {
	revoked.clear();
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

describe("anthropic-subscription resident session after a token refresh", () => {
	it("resumes on the refreshed token instead of auth-blocking a valid account", async () => {
		const store = await configureSingleAccount();
		const observations: ContinuityObservation[] = [];
		overrideContinuityObservabilityBoundary({ emit: (observation) => observations.push(observation) });
		const spawned = tokenBoundBoundary();
		const runTurn = (messages: Parameters<typeof streamAnthropicSubscription>[1]["messages"]) =>
			streamAnthropicSubscription(model, { messages }, { sessionId: SESSION_ID, streamKind: "main" }).result();

		const user1 = { role: "user" as const, content: "first", timestamp: 1 };
		const user2 = { role: "user" as const, content: "second", timestamp: 3 };
		await runTurn([user1]);
		const lineage = getSession(SESSION_ID)?.sdkSessionId;
		await refreshElsewhere(store);

		const turn2 = await runTurn([user1, assistant("first answer", 2), user2]);

		expect(turn2.stopReason).not.toBe("error");
		expect(turn2.content).toEqual([{ type: "text", text: "access-2-answer-1" }]);
		expect(spawned.map((entry) => entry.token)).toEqual(["access-1", "access-2"]);
		expect(spawned[1]?.options).toMatchObject({ resume: lineage });
		expect(observations.some((entry) => entry.reason === "credential_refreshed")).toBe(true);
		const credential = (await store.read(PROVIDER)) as AnthropicSubscriptionCredential;
		expect(credential.accounts?.[0]?.blockReason).toBeUndefined();
	}, 10_000);
});
