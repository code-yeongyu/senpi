/**
 * senpi#5630: Claude Code answers "Not logged in · Please run /login" when it cannot read an account's login, which
 * covers a locked macOS keychain as well as an empty account dir. That says what this process could read, so it must
 * not block the account for other sessions; a token the server rejected still does.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type {
	AccountSlot,
	AnthropicSubscriptionCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { overrideAuthLaneBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
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

const ALICE = "a".repeat(32);
const BOB = "b".repeat(32);
const NOT_LOGGED_IN = "Not logged in · Please run /login";
const TOKEN_REJECTED =
	'Please run /login · API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}';
const roots: string[] = [];
const sessions: string[] = [];
const user = { role: "user" as const, content: "hi", timestamp: 1 };
let clock = 1_800_000_000_000;

function cliSlot(name: string, dirId: string): AccountSlot {
	return { name, source: "login", store: "claude-cli", dirId } as AccountSlot;
}

async function installLane(slots: AccountSlot[], pinned?: string): Promise<InMemoryCredentialStore> {
	const root = mkdtempSync(join(tmpdir(), "senpi-5630-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sharedRoot = join(root, "shared");
	mkdirSync(agentDir);
	mkdirSync(sharedRoot);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ claudeSdkOauthProvider: {} }));
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_CODE_EXECUTABLE = "/bin/true";
	const store = new InMemoryCredentialStore();
	await store.modify(SCRIPTED_PROVIDER, async () => ({
		...slots.reduce((credential, slot) => addAccount(credential, slot), emptyCredential()),
		...(pinned === undefined ? {} : { pinned }),
	}));
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: sharedRoot }),
		getAgentDir: () => agentDir,
		now: () => clock,
		claudeCliAuthStatus: async () => ({ state: "signed_in", profile: {} }),
	} as Parameters<typeof overrideAuthLaneBoundary>[0]);
	return store;
}

/** Claude Code stand-in keyed by the account dir it runs in: `failures` lists the text each dir answers with, once each. */
function installSdk(failures: Record<string, string[]>): string[] {
	const ran: string[] = [];
	const query: SdkQuery = ({ prompt, options }) => {
		if (typeof prompt === "string") throw new Error("streaming input expected");
		const dirId = basename(options?.env?.CLAUDE_CONFIG_DIR ?? "");
		ran.push(dirId);
		const failure = failures[dirId]?.shift();
		return new ScriptedResidentQuery(
			prompt,
			(sessionId, _user, n) => [
				sdkMessage({
					type: "assistant",
					message: {
						id: `m-${n}`,
						type: "message",
						role: "assistant",
						content: failure === undefined ? [] : [{ type: "text", text: failure }],
					},
					...(failure === undefined ? {} : { error: "authentication_failed" }),
					parent_tool_use_id: null,
					uuid: `a-${n}`,
					session_id: sessionId,
				}),
				sdkMessage({
					type: "result",
					subtype: "success",
					...(failure === undefined ? {} : { is_error: true }),
					result: failure ?? `ok-${n}`,
					session_id: sessionId,
				}),
			],
			options,
		);
	};
	overrideSdkBoundary({
		query,
		getSessionMessages: async () => [],
		createSdkMcpServer: (() => ({ type: "sdk", name: "senpi" })) as never,
	});
	overrideSessionRegistryBoundary({ queryFactory: query });
	return ran;
}

function turn(sessionId: string): Promise<AssistantMessage> {
	sessions.push(sessionId);
	return streamAnthropicSubscription(
		model,
		{ messages: [user] },
		{ cwd: process.env.SENPI_CODING_AGENT_DIR, sessionId, streamKind: "main" },
	).result();
}

async function storedBlocks(store: InMemoryCredentialStore): Promise<(string | undefined)[]> {
	const credential = (await store.read(SCRIPTED_PROVIDER)) as AnthropicSubscriptionCredential;
	return (credential.accounts ?? []).map((slot) => slot.blockReason);
}

afterEach(() => {
	for (const id of sessions.splice(0)) {
		closeSession(id, "test_cleanup");
		forgetBinding(id);
	}
	resetScriptedSdk();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("senpi#5630 Claude Code could not read the login", () => {
	it("fails only that turn, names the keychain unlock, and the next session still reaches Claude Code", async () => {
		const store = await installLane([cliSlot("alice", ALICE)]);
		const ran = installSdk({ [ALICE]: [NOT_LOGGED_IN] });

		const failed = await turn("s1");
		clock += 60_000;
		const next = await turn("s2");

		expect(failed.errorMessage).toContain(NOT_LOGGED_IN);
		expect(failed.errorMessage).toMatch(/keychain is locked, unlock it/);
		expect(failed.errorMessage).toContain("/login anthropic-subscription");
		expect(next.errorMessage).toBeUndefined();
		expect(ran).toEqual([ALICE, ALICE]);
		expect(await storedBlocks(store)).toEqual([undefined]);
	});

	it("moves the failing turn to another account", async () => {
		const store = await installLane([cliSlot("alice", ALICE), cliSlot("bob", BOB)], "alice");
		const ran = installSdk({ [ALICE]: [NOT_LOGGED_IN] });

		const served = await turn("s1");

		expect(served.errorMessage).toBeUndefined();
		expect(ran).toEqual([ALICE, BOB]);
		expect(await storedBlocks(store)).toEqual([undefined, undefined]);
	});

	it("still blocks the account for every session when the server rejected the token", async () => {
		const store = await installLane([cliSlot("alice", ALICE)]);
		const ran = installSdk({ [ALICE]: [TOKEN_REJECTED] });

		await turn("s1");
		clock += 60_000;
		const refused = await turn("s2");

		expect(refused.errorMessage).toMatch(/currently blocked \(authentication error\)/);
		expect(ran).toEqual([ALICE]);
		expect(await storedBlocks(store)).toEqual(["auth_error"]);
	});
});
