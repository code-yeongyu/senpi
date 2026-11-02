/**
 * senpi#4436 (S4): a `claude-cli` account runs turns on its own lane. Its turn env pins
 * `CLAUDE_CONFIG_DIR=<account dir>` and carries no inherited token, a restart reattaches through the
 * shared transcript root, an init that reports an env token fails closed before the prompt is sent,
 * an auth block clears only when `claude auth status` reports a login, and a sign-in-required slot
 * is never selected.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { CredentialStoreBusyError } from "../../../src/core/lockfile-policy.ts";
import { afterEach, describe, expect, it } from "vitest";
import type {
	AccountSlot,
	AnthropicSubscriptionCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { overrideAuthLaneBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import type { ClaudeCliAuthStatus } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth-status.ts";
import type {
	SdkQuery,
	SessionMessage,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { overrideSdkBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	type ContinuityObservation,
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import {
	forgetBinding,
	getBinding,
	rememberBinding,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { sentHashPrefixDigest } from "../../../src/core/extensions/builtin/anthropic-subscription/session-sync.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import {
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	ScriptedResidentQuery,
	sdkMessage,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";

const SESSION_ID = "issue-4436-cli-slot-lane";
const DIR_A = "a".repeat(32);
const DIR_B = "b".repeat(32);
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

const roots: string[] = [];
const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;

type Lane = { agentDir: string; sharedRoot: string; store: InMemoryCredentialStore; probes: string[] };
type LaneOptions = { pinned?: string; hostEnv?: Record<string, string>; status?: ClaudeCliAuthStatus };

function cliSlot(name: string, dirId: string, extra: Record<string, unknown> = {}): AccountSlot {
	return { name, source: "login", store: "claude-cli", dirId, ...extra } as AccountSlot;
}

async function installCliLane(slots: AccountSlot[], options: LaneOptions = {}): Promise<Lane> {
	const root = mkdtempSync(join(tmpdir(), "senpi-4436-cli-lane-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sharedRoot = join(root, "shared-claude");
	mkdirSync(agentDir);
	mkdirSync(sharedRoot);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ claudeSdkOauthProvider: {} }));
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_CODE_EXECUTABLE = "/bin/true";
	const store = new InMemoryCredentialStore();
	await store.modify(SCRIPTED_PROVIDER, async () => ({
		...slots.reduce<AnthropicSubscriptionCredential>(
			(credential, slot) => addAccount(credential, slot),
			emptyCredential(),
		),
		...(options.pinned === undefined ? {} : { pinned: options.pinned }),
	}));
	const probes: string[] = [];
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: sharedRoot, ...options.hostEnv }),
		getAgentDir: () => agentDir,
		claudeCliAuthStatus: async (configDir: string) => {
			probes.push(configDir);
			return options.status ?? { state: "signed_out" };
		},
	} as Parameters<typeof overrideAuthLaneBoundary>[0]);
	return { agentDir, sharedRoot, store, probes };
}

function accountDir(lane: Lane, dirId: string): string {
	return join(lane.agentDir, "anthropic-subscription-claude", dirId);
}

/** Like the real CLI, the fake writes its transcript under `CLAUDE_CONFIG_DIR/projects` and reads the shared root back. */
function installCliSdk(
	lane: Lane,
	init?: unknown,
	initializationResult?: () => Promise<unknown>,
): { queries: ScriptedResidentQuery[]; reads: string[] } {
	const queries: ScriptedResidentQuery[] = [];
	const reads: string[] = [];
	const script = (sessionId: string, userUuid: string, submission: number) => {
		const projects = join(queries.at(-1)?.options?.env?.CLAUDE_CONFIG_DIR ?? "", "projects");
		const assistantUuid = `assistant-${submission}`;
		if (existsSync(projects)) {
			const lines = [
				{ type: "user", uuid: userUuid, session_id: sessionId, parent_tool_use_id: null, message: {} },
				{ type: "assistant", uuid: assistantUuid, session_id: sessionId, parent_tool_use_id: null, message: {} },
			];
			appendFileSync(
				join(projects, `${sessionId}.jsonl`),
				`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
			);
		}
		return [
			sdkMessage({
				type: "assistant",
				message: { id: `m-${submission}`, type: "message", role: "assistant", content: [] },
				parent_tool_use_id: null,
				uuid: assistantUuid,
				session_id: sessionId,
			}),
			sdkMessage({ type: "result", subtype: "success", result: `answer-${submission}`, session_id: sessionId }),
		];
	};
	const query: SdkQuery = ({ prompt, options }) => {
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		const handle = new ScriptedResidentQuery(prompt, script, options);
		if (initializationResult) Object.assign(handle, { initializationResult });
		else if (init !== undefined) Object.assign(handle, { initializationResult: async () => init });
		queries.push(handle);
		return handle;
	};
	const getSessionMessages = async (sessionId: string): Promise<SessionMessage[]> => {
		const file = join(lane.sharedRoot, "projects", `${sessionId}.jsonl`);
		reads.push(file);
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as SessionMessage);
	};
	overrideSdkBoundary({
		query,
		getSessionMessages,
		createSdkMcpServer: (() => ({ type: "sdk", name: "senpi" })) as never,
	});
	overrideSessionRegistryBoundary({ queryFactory: query });
	return { queries, reads };
}

function runTurn(context: Context, signal?: AbortSignal): Promise<AssistantMessage> {
	return streamAnthropicSubscription(model, context, {
		cwd: process.env.SENPI_CODING_AGENT_DIR,
		sessionId: SESSION_ID,
		streamKind: "main",
		...(signal === undefined ? {} : { signal }),
	}).result();
}

async function storedSlot(lane: Lane, name: string): Promise<Record<string, unknown> | undefined> {
	const credential = (await lane.store.read(SCRIPTED_PROVIDER)) as AnthropicSubscriptionCredential | undefined;
	return credential?.accounts?.find((slot) => slot.name === name) as Record<string, unknown> | undefined;
}

const user1 = { role: "user" as const, content: "first", timestamp: 1 };
const assistant1 = {
	role: "assistant",
	content: [{ type: "text", text: "answer-1" }],
	stopReason: "stop",
	timestamp: 2,
};
const user2 = { role: "user" as const, content: "second", timestamp: 3 };

afterEach(() => {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	resetContinuityObservabilityBoundary();
	resetScriptedSdk();
	if (originalExecutable === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
	else process.env.CLAUDE_CODE_EXECUTABLE = originalExecutable;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("senpi#4436 claude-cli account lane", () => {
	it("(a) a CLI slot's turn env has CLAUDE_CONFIG_DIR and no CLAUDE_CODE_OAUTH_TOKEN even when the host env has one", async () => {
		const lane = await installCliLane([cliSlot("alice", DIR_A)], {
			pinned: "alice",
			hostEnv: {
				CLAUDE_CODE_OAUTH_TOKEN: "host-oauth-token",
				CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "9",
				CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "10",
				ANTHROPIC_API_KEY: "host-api-key",
			},
		});
		const { queries } = installCliSdk(lane, {
			account: {
				apiProvider: "firstParty",
				tokenSource: "none",
				email: "alice@example.com",
				subscriptionType: "max",
			},
		});

		const turn = await runTurn({ messages: [user1] });

		expect(turn.errorMessage).toBeUndefined();
		expect(queries).toHaveLength(1);
		const env = queries[0]?.options?.env ?? {};
		expect(env.CLAUDE_CONFIG_DIR).toBe(accountDir(lane, DIR_A));
		expect(
			Object.keys(env).filter((name) =>
				/^(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|ANTHROPIC_API_KEY)/.test(name),
			),
		).toEqual([]);
		expect(JSON.stringify(env)).not.toContain("host-oauth-token");
		expect(await storedSlot(lane, "alice")).toMatchObject({
			profile: { email: "alice@example.com", subscriptionType: "max" },
		});
	});

	it("(b) restart reattach verifies through the shared root (not cross_root_unsupported)", async () => {
		const lane = await installCliLane([cliSlot("alice", DIR_A)], { pinned: "alice" });
		const { queries, reads } = installCliSdk(lane);
		const observations: ContinuityObservation[] = [];
		overrideContinuityObservabilityBoundary({ emit: (observation) => observations.push(observation), log: () => {} });
		await runTurn({ messages: [user1] });
		const live = getBinding(SESSION_ID);
		if (live === undefined) throw new Error("expected a live binding after the first turn");
		expect(live.lastAssistantUuid).toBe("assistant-1");
		closeSession(SESSION_ID, "test_restart");
		rememberBinding({ ...live, sentPrefixHash: sentHashPrefixDigest(live.sentHashes, live.sentCount) });

		const turn = await runTurn({ messages: [user1, assistant1 as AssistantMessage, user2] });

		expect(turn.errorMessage).toBeUndefined();
		expect(reads).toEqual([join(lane.sharedRoot, "projects", `${live.sdkSessionId}.jsonl`)]);
		expect(queries.at(-1)?.options).toMatchObject({ resume: live.sdkSessionId });
		expect(observations.map((observation) => observation.reason)).not.toContain("cross_root_unsupported");
		expect(observations.map((observation) => observation.reason)).not.toContain("transcript_missing");
	});

	it("(c) an init account with tokenSource from CLAUDE_CODE_OAUTH_TOKEN fails the attempt closed with ClaudeCliTokenSourceLeak", async () => {
		const lane = await installCliLane([cliSlot("alice", DIR_A)], { pinned: "alice" });
		const { queries } = installCliSdk(lane, {
			account: { apiProvider: "firstParty", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" },
		});

		const turn = await runTurn({ messages: [user1] });

		expect(turn.stopReason).toBe("error");
		expect(turn.errorMessage).toMatch(/ClaudeCliTokenSourceLeak/);
		expect(queries).toHaveLength(1);
		expect(queries[0]?.submitted).toEqual([]);
	});

	it("(c2) an abort while the CLI's initialization hangs ends the turn without sending the prompt", async () => {
		const lane = await installCliLane([cliSlot("alice", DIR_A)], { pinned: "alice" });
		const controller = new AbortController();
		// The CLI never finishes initializing; the user aborts once the wait has started.
		const { queries } = installCliSdk(lane, undefined, () => {
			controller.abort();
			return new Promise<never>(() => {});
		});

		const turn = await runTurn({ messages: [user1] }, controller.signal);

		expect(turn.stopReason === "aborted" || turn.stopReason === "error").toBe(true);
		expect(queries).toHaveLength(1);
		expect(queries[0]?.submitted).toEqual([]);
	});

	it("(c3) a busy store while storing the reported profile never fails a verified turn", async () => {
		const lane = await installCliLane([cliSlot("alice", DIR_A)], { pinned: "alice" });
		const { queries } = installCliSdk(lane, {
			account: { apiProvider: "firstParty", tokenSource: "none", email: "alice@example.com" },
		});
		lane.store.modify = async () => {
			throw new CredentialStoreBusyError("auth.json.lock", 5_000);
		};

		const turn = await runTurn({ messages: [user1] });

		expect(turn.errorMessage).toBeUndefined();
		expect(queries[0]?.submitted).toHaveLength(1);
	});

	it("(d) an auth_error-blocked CLI slot clears only when auth status reports loggedIn", async () => {
		const blocked = { blockReason: "auth_error", blockedUntil: Date.now() - 1, blockedAt: Date.now() - 10 };
		const out = await installCliLane([cliSlot("alice", DIR_A, blocked)], { pinned: "alice" });
		const signedOut = installCliSdk(out);
		const refused = await runTurn({ messages: [user1] });
		expect(out.probes).toEqual([accountDir(out, DIR_A)]);
		expect(refused.stopReason).toBe("error");
		expect(signedOut.queries).toEqual([]);
		const stillBlocked = await storedSlot(out, "alice");
		expect(stillBlocked).toMatchObject({ blockReason: "auth_error" });
		expect(stillBlocked?.blockedUntil as number).toBeGreaterThan(Date.now());
		closeSession(SESSION_ID, "test_cleanup");

		const back = await installCliLane([cliSlot("alice", DIR_A, blocked)], {
			pinned: "alice",
			status: { state: "signed_in", profile: {} },
		});
		const signedIn = installCliSdk(back);
		const served = await runTurn({ messages: [user1] });
		expect(served.errorMessage).toBeUndefined();
		expect(signedIn.queries).toHaveLength(1);
		expect(await storedSlot(back, "alice")).not.toHaveProperty("blockReason");
	});

	it("(e) a signInRequired slot is never selected", async () => {
		const retired = cliSlot("retired", DIR_A, { signInRequired: "legacy_sign_in_retired" });
		const lane = await installCliLane([retired, cliSlot("fresh", DIR_B)], { pinned: "retired" });
		const { queries } = installCliSdk(lane);
		await runTurn({ messages: [user1] });
		expect(queries.map((query) => query.options?.env?.CLAUDE_CONFIG_DIR)).toEqual([accountDir(lane, DIR_B)]);
		closeSession(SESSION_ID, "test_cleanup");
		forgetBinding(SESSION_ID);

		const only = await installCliLane([retired], { pinned: "retired" });
		const onlyRetired = installCliSdk(only);
		const turn = await runTurn({ messages: [user1] });
		expect(turn.errorMessage).toMatch(/Sign in again with Claude to keep using: retired\./);
		expect(onlyRetired.queries).toEqual([]);
	});
});
