/**
 * senpi#5350 (PR-A) on the auth lane: a `login_expired` account is never spawned for a turn, healthy siblings keep
 * serving, and a pool with only expired accounts fails with the expired sign-in message, which stops retries and
 * model hops. The end-to-end case runs the `auth_error` path only (failing turn -> block -> due probe signed_out);
 * the SDK error a refused grant really produces is the open Q1 capture.
 *
 * Guard test (already green on main): "a sibling serves".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_BLOCK_REPROBE_MS } from "../../../src/core/credential-pool/auth-reprobe.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import type { ClaudeCliAuthStatus } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth-status.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { resetSessionRegistryBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { isSignInAgainError } from "../../../src/core/extensions/builtin/anthropic-subscription/sign-in-again.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { cliAccountOf, cliLaneEnv, cliSlot } from "../../support/claude-cli-test-slots.ts";

const PROVIDER = "anthropic-subscription";
const START = 1_800_000_000_000;
const EXPIRED_TEXT = "Claude sign-in expired. Sign in again with Claude to keep using: ";
const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: PROVIDER,
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};
const expired = (until: number) =>
	({ signInRequired: "login_expired", blockReason: "auth_error", blockedUntil: until, blockedAt: until - 1 }) as const;

const dirs: string[] = [];
const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;

afterEach(() => {
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetAuthLaneBoundary();
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Lane = { store: InMemoryCredentialStore; spawned: string[]; clock: { now: number }; probes: string[] };

async function installLane(
	slots: AccountSlot[],
	status: () => Promise<ClaudeCliAuthStatus>,
	failFor: (account: string, spawn: number) => boolean = () => false,
): Promise<Lane> {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-5350-lane-"));
	dirs.push(agentDir);
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () => slots.reduce(addAccount, emptyCredential()));
	const lane: Lane = { store, spawned: [], clock: { now: START }, probes: [] };
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => cliLaneEnv(),
		getAgentDir: () => agentDir,
		now: () => lane.clock.now,
		claudeCliAuthStatus: async (configDir) => {
			lane.probes.push(configDir);
			return status();
		},
	});
	const query: SdkQuery = (input) => {
		const account = cliAccountOf(input.options?.env);
		lane.spawned.push(account);
		if (failFor(account, lane.spawned.length)) {
			throw new Error("Failed to authenticate. API Error: 401 (authentication_failed)");
		}
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
	overrideSdkBoundary({ query });
	return lane;
}

function runTurn() {
	return streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() }).result();
}

async function stored(lane: Lane, name: string): Promise<AccountSlot | undefined> {
	const credential = (await lane.store.read(PROVIDER)) as AnthropicSubscriptionCredential;
	return credential.accounts?.find((slot) => slot.name === name);
}

describe("senpi#5350 login_expired on the auth lane", () => {
	it("guard: a login_expired account is never spawned and a sibling serves", async () => {
		const lane = await installLane(
			[cliSlot("alpha", expired(START + AUTH_BLOCK_REPROBE_MS)), cliSlot("bravo")],
			async () => ({ state: "signed_out" }),
		);
		const result = await runTurn();
		expect(result.errorMessage).toBeUndefined();
		expect(lane.spawned).toEqual(["bravo"]);
	});

	it("RED: with every account expired the turn fails with the expired sign-in message naming them", async () => {
		const until = START + AUTH_BLOCK_REPROBE_MS;
		const lane = await installLane([cliSlot("alpha", expired(until)), cliSlot("bravo", expired(until))], async () => ({
			state: "signed_out",
		}));
		const result = await runTurn();
		expect(lane.spawned).toEqual([]);
		expect(result.errorMessage).toContain(`${EXPIRED_TEXT}alpha, bravo.`);
		expect(isSignInAgainError(result.errorMessage)).toBe(true);
	});

	it("RED (LOW-N4): a thrown probe on an all-login_expired pool surfaces the sign-in message, not transientError", async () => {
		const lane = await installLane([cliSlot("alpha", expired(START - 1))], async () => {
			throw new Error("spawn failed");
		});
		const result = await runTurn();
		expect(lane.probes).toHaveLength(1);
		expect(lane.spawned).toEqual([]);
		expect(result.errorMessage).toContain(`${EXPIRED_TEXT}alpha.`);
		expect(isSignInAgainError(result.errorMessage)).toBe(true);
	});

	it("RED (auth_error path only, Q1 open): failed turn -> block -> due probe signed_out -> expired, no spawn", async () => {
		const lane = await installLane(
			[cliSlot("alice")],
			async () => ({ state: "signed_out" }),
			(_account, spawn) => spawn === 1,
		);
		const first = await runTurn();
		expect(first.stopReason).toBe("error");
		expect(await stored(lane, "alice")).toMatchObject({
			blockReason: "auth_error",
			blockedUntil: START + AUTH_BLOCK_REPROBE_MS,
		});

		lane.clock.now = START + AUTH_BLOCK_REPROBE_MS + 1;
		const second = await runTurn();

		expect(lane.spawned).toEqual(["alice"]);
		expect(lane.probes).toHaveLength(1);
		expect(second.errorMessage).toContain(`${EXPIRED_TEXT}alice.`);
		expect(await stored(lane, "alice")).toMatchObject({ signInRequired: "login_expired", blockReason: "auth_error" });
	});
});
