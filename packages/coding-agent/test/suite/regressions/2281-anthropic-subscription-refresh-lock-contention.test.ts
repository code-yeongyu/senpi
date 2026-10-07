/**
 * senpi#2281: the lane redeems the refresh token under the auth.json lock. A session that reaches
 * the refresh window while a sibling holds that lock past the wait budget got
 * `CredentialStoreBusyError`, which `prepareSlot` relabelled `authentication_failed`, so contention
 * failed the turn as a credential verdict. Token-endpoint throttling and server errors took the same
 * path. Pinned here: contention adopts the sibling's rotation or keeps a still-valid token, and only
 * a rejected grant is stamped `auth_error`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type Context,
	type Credential,
	type CredentialStore,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
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
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { CredentialStoreBusyError } from "../../../src/core/lockfile-policy.ts";

const PROVIDER = "anthropic-subscription";
const NOW = Date.parse("2026-09-28T00:00:00.000Z");
const MINUTE = 60_000;
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

/** auth.json double whose first writer finds the lock held by a sibling that may rotate the slot first. */
class ContendedStore implements CredentialStore {
	readonly inner = new InMemoryCredentialStore();
	busyWrites = 1;
	siblingRotation: Partial<AccountSlot> | undefined;

	read(provider: string) {
		return this.inner.read(provider);
	}

	list() {
		return this.inner.list();
	}

	async modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
		if (this.busyWrites === 0) return this.inner.modify(provider, fn);
		this.busyWrites--;
		const rotation = this.siblingRotation;
		if (rotation) await patchSlot(this.inner, rotation);
		throw new CredentialStoreBusyError("auth.json", 5_500);
	}

	delete(provider: string) {
		return this.inner.delete(provider);
	}
}

async function patchSlot(store: CredentialStore, patch: Partial<AccountSlot>): Promise<void> {
	await store.modify(PROVIDER, async (current) => {
		const credential = current as AnthropicSubscriptionCredential;
		return { ...credential, accounts: credential.accounts?.map((slot) => ({ ...slot, ...patch })) };
	});
}

async function storedSlot(store: CredentialStore): Promise<AccountSlot | undefined> {
	return ((await store.read(PROVIDER)) as AnthropicSubscriptionCredential).accounts?.[0];
}

async function configure(
	store: CredentialStore,
	seed: CredentialStore,
	expires: number,
	refresher?: () => Promise<never>,
) {
	await seed.modify(PROVIDER, async () =>
		addAccount(emptyCredential(), {
			name: "default",
			access: "access-1",
			refresh: "refresh-1",
			expires,
			source: "login",
		}),
	);
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-2281-"));
	directories.push(agentDir);
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ claudeSdkOauthProvider: { tokenInjection: "oauth-slots" } }),
	);
	const refreshes: string[] = [];
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin" }),
		getAgentDir: () => agentDir,
		now: () => NOW,
		refresher:
			refresher ??
			(async (refresh) => {
				refreshes.push(refresh);
				return { access: "access-2", refresh: "refresh-2", expires: NOW + 480 * MINUTE };
			}),
	});
	const spawned: Options[] = [];
	const query: SdkQuery = ({ options = {} }) => {
		spawned.push(options);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
	overrideSdkBoundary({ query });
	return { refreshes, spawned };
}

afterEach(() => {
	resetSdkBoundary();
	resetAuthLaneBoundary();
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("senpi#2281 refresh under a contended auth.json lock", () => {
	it("keeps the stored token while it is inside its lifetime", async () => {
		const store = new ContendedStore();
		const lane = await configure(store, store.inner, NOW + 2 * MINUTE);

		const result = await streamAnthropicSubscription(model, context).result();

		expect(result.errorMessage).toBeUndefined();
		expect(lane.spawned.map((options) => options.env?.CLAUDE_CODE_OAUTH_TOKEN)).toEqual(["access-1"]);
		expect((await storedSlot(store))?.blockReason).toBeUndefined();
	});

	it("adopts the token a sibling rotated while it held the lock", async () => {
		const store = new ContendedStore();
		store.siblingRotation = { access: "access-sibling", refresh: "refresh-sibling", expires: NOW + 480 * MINUTE };
		const lane = await configure(store, store.inner, NOW + 2 * MINUTE);

		await streamAnthropicSubscription(model, context).result();

		expect(lane.spawned.map((options) => options.env?.CLAUDE_CODE_OAUTH_TOKEN)).toEqual(["access-sibling"]);
		expect((await storedSlot(store))?.blockReason).toBeUndefined();
	});

	it("fails an expired token as contention, never as an authentication verdict", async () => {
		const store = new ContendedStore();
		const lane = await configure(store, store.inner, NOW - MINUTE);

		const result = await streamAnthropicSubscription(model, context).result();

		expect(result.errorMessage).toContain("Credential store is busy");
		expect(result.errorMessage).not.toContain("authentication_failed");
		expect(lane.spawned).toEqual([]);
		expect((await storedSlot(store))?.blockReason).toBeUndefined();
	});
});

describe("senpi#2281 token endpoint failures", () => {
	async function refreshFailingWith(detail: string) {
		const store = new InMemoryCredentialStore();
		await configure(store, store, NOW - MINUTE, async () => {
			throw new Error(`Anthropic token refresh request failed. url=https://token.invalid; details=${detail}`);
		});
		await streamAnthropicSubscription(model, context).result();
		return storedSlot(store);
	}

	it.each([
		["a throttled exchange", "Error: HTTP request failed. status=429; body=rate limited"],
		["a server error", "Error: HTTP request failed. status=503; body=unavailable"],
		["a timed-out exchange", "TimeoutError: The operation timed out."],
	])("does not stamp auth_error for %s", async (_label, detail) => {
		expect((await refreshFailingWith(detail))?.blockReason).not.toBe("auth_error");
	});

	it("stamps auth_error when the grant itself is rejected", async () => {
		const detail = 'Error: HTTP request failed. status=400; body={"error":"invalid_grant"}';
		expect((await refreshFailingWith(detail))?.blockReason).toBe("auth_error");
	});
});
