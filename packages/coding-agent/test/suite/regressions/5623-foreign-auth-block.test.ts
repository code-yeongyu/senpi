/**
 * senpi#5623: an engine from before v2026.10.31-1 writes an auth_error block onto a Claude CLI slot about a token
 * the slot never had (its `persistBlock` writes `blockReason`, `blockedUntil` and `blockedAt` onto the stored slot).
 * Such a block must not refuse the slot locally or list it as blocked; a verdict this engine reached itself still does.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { getCredentialAccounts } from "../../../src/core/credential-accounts.ts";
import { getProviderAccounts } from "../../../src/core/extensions/builtin/anthropic-subscription/account-management.ts";
import type {
	AccountSlot,
	AnthropicSubscriptionCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { overrideAuthLaneBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import type { ClaudeCliAuthStatus } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth-status.ts";
import type { SdkQuery } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { overrideSdkBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import {
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	ScriptedResidentQuery,
	sdkMessage,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";

const model = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: SCRIPTED_PROVIDER,
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} satisfies Model<Api>;

const DIR = "a".repeat(32);
const REPROBE_MS = 15 * 60_000;
const roots: string[] = [];
const sessions: string[] = [];
const user = { role: "user" as const, content: "hi", timestamp: 1 };
let clock = 1_800_000_000_000;

function cliSlot(extra: Record<string, unknown> = {}): AccountSlot {
	return { name: "alice", source: "login", store: "claude-cli", dirId: DIR, ...extra } as AccountSlot;
}

/** The fields the v2026.10.30-1 `persistBlock` writes onto the stored slot it matched by name. */
function preCliEngineBlock(): Record<string, unknown> {
	return { blockReason: "auth_error", blockedUntil: clock + REPROBE_MS, blockedAt: clock };
}

async function installLane(slot: AccountSlot, status: ClaudeCliAuthStatus = { state: "signed_in", profile: {} }) {
	const root = mkdtempSync(join(tmpdir(), "senpi-5623-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sharedRoot = join(root, "shared");
	mkdirSync(agentDir);
	mkdirSync(sharedRoot);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ claudeSdkOauthProvider: {} }));
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_CODE_EXECUTABLE = "/bin/true";
	const store = new InMemoryCredentialStore();
	await store.modify(SCRIPTED_PROVIDER, async () => addAccount(emptyCredential(), slot));
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: sharedRoot }),
		getAgentDir: () => agentDir,
		now: () => clock,
		claudeCliAuthStatus: async () => status,
	} as Parameters<typeof overrideAuthLaneBoundary>[0]);
	return store;
}

const TOKEN_REJECTED =
	'Please run /login · API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}';

/** Claude Code stand-in: the first `failing` spawns answer with a token the server rejected, the rest serve the turn. */
function installSdk(failing = 0): ScriptedResidentQuery[] {
	const queries: ScriptedResidentQuery[] = [];
	const query: SdkQuery = ({ prompt, options }) => {
		if (typeof prompt === "string") throw new Error("streaming input expected");
		const fail = queries.length < failing;
		const handle = new ScriptedResidentQuery(
			prompt,
			(sessionId, _user, n) => [
				sdkMessage({
					type: "assistant",
					message: {
						id: `m-${n}`,
						type: "message",
						role: "assistant",
						content: fail ? [{ type: "text", text: TOKEN_REJECTED }] : [],
					},
					...(fail ? { error: "authentication_failed" } : {}),
					parent_tool_use_id: null,
					uuid: `a-${n}`,
					session_id: sessionId,
				}),
				sdkMessage({
					type: "result",
					subtype: "success",
					...(fail ? { is_error: true } : {}),
					result: fail ? TOKEN_REJECTED : `ok-${n}`,
					session_id: sessionId,
				}),
			],
			options,
		);
		queries.push(handle);
		return handle;
	};
	overrideSdkBoundary({
		query,
		getSessionMessages: async () => [],
		createSdkMcpServer: (() => ({ type: "sdk", name: "senpi" })) as never,
	});
	overrideSessionRegistryBoundary({ queryFactory: query });
	return queries;
}

function turn(sessionId: string): Promise<AssistantMessage> {
	sessions.push(sessionId);
	return streamAnthropicSubscription(
		model,
		{ messages: [user] },
		{ cwd: process.env.SENPI_CODING_AGENT_DIR, sessionId, streamKind: "main" },
	).result();
}

async function stored(store: InMemoryCredentialStore): Promise<AnthropicSubscriptionCredential> {
	return (await store.read(SCRIPTED_PROVIDER)) as AnthropicSubscriptionCredential;
}

async function listings(credential: AnthropicSubscriptionCredential) {
	const storage = AuthStorage.inMemory({ [SCRIPTED_PROVIDER]: credential });
	return {
		lane: getProviderAccounts(storage, SCRIPTED_PROVIDER, {}),
		generic: await getCredentialAccounts(storage, SCRIPTED_PROVIDER, {}),
	};
}

afterEach(() => {
	for (const id of sessions.splice(0)) {
		closeSession(id, "test_cleanup");
		forgetBinding(id);
	}
	resetScriptedSdk();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("senpi#5623 an auth block another engine wrote about a token the Claude CLI slot never had", () => {
	it("still sends the turn to Claude Code, and no listing calls the account blocked", async () => {
		const store = await installLane(cliSlot(preCliEngineBlock()));
		const queries = installSdk();

		const served = await turn("s1");

		expect(served.errorMessage).toBeUndefined();
		expect(queries).toHaveLength(1);
		const { lane, generic } = await listings(await stored(store));
		expect(lane.map(({ name, blocked }) => ({ name, blocked }))).toEqual([{ name: "alice", blocked: false }]);
		expect(generic.map(({ name, blocked }) => ({ name, blocked }))).toEqual([{ name: "alice", blocked: false }]);
	});

	it("keeps this engine's own verdict: a failed sign-in refuses every session until the re-check", async () => {
		const store = await installLane(cliSlot());
		const queries = installSdk(1);

		const failed = await turn("s1");
		clock += 60_000;
		const refused = await turn("s2");

		expect(failed.errorMessage).toMatch(/API Error: 401/);
		expect(refused.errorMessage).toMatch(/currently blocked \(authentication error\)/);
		expect(refused.errorMessage).toMatch(/No request was sent/);
		expect(queries).toHaveLength(1);
		const { lane, generic } = await listings(await stored(store));
		expect(lane[0]).toMatchObject({ blocked: true, blockedReason: "auth_error" });
		expect(generic[0]).toMatchObject({ blocked: true, blockedReason: "auth_error" });
	});

	it("keeps the re-check's own re-block when the CLI reports the login signed out", async () => {
		await installLane(cliSlot(), { state: "signed_out" });
		const queries = installSdk(1);
		await turn("s1");

		clock += REPROBE_MS + 1;
		const afterRecheck = await turn("s2");
		clock += 60_000;
		const stillRefused = await turn("s3");

		expect(afterRecheck.errorMessage).toMatch(/currently blocked \(authentication error\)/);
		expect(stillRefused.errorMessage).toMatch(/currently blocked \(authentication error\)/);
		expect(queries).toHaveLength(1);
	});
});
