import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type Context,
	type CredentialStore,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	authGrantDigest,
	emptyCredential,
	upsertAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";

const PROVIDER = "anthropic-subscription";
const NOW = Date.parse("2026-10-08T00:00:00.000Z");
const MINUTE = 60_000;
const REJECTED = 'Error: HTTP request failed. status=400; body={"error":"invalid_grant"}';
const UNAVAILABLE = "Error: HTTP request failed. status=503; body=unavailable";
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
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;
const directories: string[] = [];

type Lane = {
	readonly store: CredentialStore;
	readonly refreshes: string[];
	readonly spawned: Options[];
	refreshOutcome: "ok" | "rejected" | "unavailable";
};

async function blockedLane(slot: Partial<AccountSlot>, sibling?: AccountSlot): Promise<Lane> {
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () => {
		const blocked = addAccount(emptyCredential(), {
			name: "default",
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW - MINUTE,
			source: "login",
			blockReason: "auth_error",
			...slot,
		});
		return sibling ? addAccount(blocked, sibling) : blocked;
	});
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-2926-"));
	directories.push(agentDir);
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ claudeSdkOauthProvider: { tokenInjection: "oauth-slots" } }),
	);
	const lane: Lane = { store, refreshes: [], spawned: [], refreshOutcome: "ok" };
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin" }),
		getAgentDir: () => agentDir,
		now: () => NOW,
		refresher: async (refresh) => {
			lane.refreshes.push(refresh);
			if (lane.refreshOutcome === "rejected") throw new Error(`token refresh failed; details=${REJECTED}`);
			if (lane.refreshOutcome === "unavailable") throw new Error(`token refresh failed; details=${UNAVAILABLE}`);
			return { access: "access-2", refresh: "refresh-2", expires: NOW + 480 * MINUTE };
		},
	});
	const query: SdkQuery = ({ options = {} }) => {
		lane.spawned.push(options);
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

async function storedSlot(store: CredentialStore): Promise<AccountSlot | undefined> {
	return ((await store.read(PROVIDER)) as AnthropicSubscriptionCredential).accounts?.[0];
}

afterEach(() => {
	resetSdkBoundary();
	resetAuthLaneBoundary();
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("senpi#2926 an auth-blocked slot whose saved grant still refreshes", () => {
	it.each([
		["an expired", NOW - MINUTE],
		["a still-valid", NOW + 60 * MINUTE],
	])("recovers %s access token through one refresh and clears the block", async (_label, expires) => {
		// given the sole slot is auth-blocked but its refresh token is still accepted
		const lane = await blockedLane({ expires });

		// when a request arrives
		const result = await streamAnthropicSubscription(model, context).result();

		// then the grant is redeemed once, the request runs on the new token, and the block is gone
		expect(result.errorMessage).toBeUndefined();
		expect(lane.refreshes).toEqual(["refresh-1"]);
		expect(lane.spawned.map((options) => options.env?.CLAUDE_CODE_OAUTH_TOKEN)).toEqual(["access-2"]);
		const stored = await storedSlot(lane.store);
		expect(stored).toMatchObject({ access: "access-2", refresh: "refresh-2" });
		expect(stored?.blockReason).toBeUndefined();
	});

	it("keeps a rejected grant blocked and never redeems it again", async () => {
		// given the slot's saved grant is rejected by the token endpoint
		const lane = await blockedLane({});
		lane.refreshOutcome = "rejected";

		// when two requests arrive
		const first = await streamAnthropicSubscription(model, context).result();
		const second = await streamAnthropicSubscription(model, context).result();

		// then only the first tries the grant, and both fail without spawning the SDK
		expect(first.errorMessage).toContain("blocked");
		expect(second.errorMessage).toContain("blocked");
		expect(lane.refreshes).toEqual(["refresh-1"]);
		expect(lane.spawned).toEqual([]);
		expect(await storedSlot(lane.store)).toMatchObject({
			blockReason: "auth_error",
			refresh: "refresh-1",
			authRecoveryGrant: authGrantDigest("refresh-1"),
		});
	});

	it("retries a grant whose refresh failed only transiently", async () => {
		// given the token endpoint is briefly unavailable
		const lane = await blockedLane({});
		lane.refreshOutcome = "unavailable";

		// when a request fails on that, and the endpoint recovers before the next request
		const first = await streamAnthropicSubscription(model, context).result();
		lane.refreshOutcome = "ok";
		const result = await streamAnthropicSubscription(model, context).result();

		// then the first request fails as a retryable server error, and the grant is tried again and recovers
		expect(first.errorMessage).toMatch(/^server_error:/);
		expect(result.errorMessage).toBeUndefined();
		expect(lane.refreshes).toEqual(["refresh-1", "refresh-1"]);
		expect((await storedSlot(lane.store))?.blockReason).toBeUndefined();
	});

	it("leaves the blocked slot alone while a healthy sibling can serve the request", async () => {
		// given a second account that is not blocked
		const lane = await blockedLane(
			{},
			{
				name: "spare",
				access: "access-spare",
				refresh: "refresh-spare",
				expires: NOW + 60 * MINUTE,
				source: "login",
			},
		);
		lane.refreshOutcome = "unavailable";

		// when two requests arrive
		await streamAnthropicSubscription(model, context).result();
		await streamAnthropicSubscription(model, context).result();

		// then the sibling serves both and the blocked grant is never redeemed
		expect(lane.refreshes).toEqual([]);
		expect(lane.spawned.map((options) => options.env?.CLAUDE_CODE_OAUTH_TOKEN)).toEqual([
			"access-spare",
			"access-spare",
		]);
	});

	it("clears the recovery marker on a re-login", () => {
		// given a slot that already used its one recovery
		const credential = addAccount(emptyCredential(), {
			name: "default",
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW,
			source: "login",
			blockReason: "auth_error",
			authRecoveryGrant: authGrantDigest("refresh-1"),
		});

		// when the user logs in again under the same name
		const relogged = upsertAccount(credential, {
			name: "default",
			access: "access-new",
			refresh: "refresh-new",
			expires: NOW + 480 * MINUTE,
			source: "login",
		});

		// then the block and the marker are both gone
		expect(relogged.accounts?.[0]?.blockReason).toBeUndefined();
		expect(relogged.accounts?.[0]?.authRecoveryGrant).toBeUndefined();
	});

	it("does not recover again when the grant it recovered to is blocked as well", async () => {
		// given an earlier recovery produced this grant, and the account was auth-blocked on it again
		const lane = await blockedLane({ authRecoveryGrant: authGrantDigest("refresh-1") });

		// when a request arrives
		const result = await streamAnthropicSubscription(model, context).result();

		// then no refresh is attempted and the account still asks for a re-login
		expect(result.errorMessage).toContain("blocked");
		expect(lane.refreshes).toEqual([]);
		expect((await storedSlot(lane.store))?.blockReason).toBe("auth_error");
	});
});
