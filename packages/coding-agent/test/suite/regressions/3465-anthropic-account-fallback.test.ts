// Issue #3465: disabling model fallback must not be the only way to control account spending.
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AccountSlot,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { forgetSessionBlocksFor } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import type { SDKMessage, SdkQuery } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { loadAnthropicSubscriptionProviderSettings } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";

const now = 1_800_000_000_000;
const providerId = "anthropic-subscription";
const primary: AccountSlot = {
	name: "primary",
	access: "primary",
	refresh: "primary-refresh",
	expires: now + 86_400_000,
	source: "login",
};
const secondary: AccountSlot = { ...primary, name: "secondary", access: "secondary" };

function settings(
	global: Readonly<Record<string, unknown>> = {},
	project: unknown = {},
	environment: Record<string, string | undefined> = {},
) {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () =>
		JSON.stringify({ anthropicSubscriptionProvider: { tokenInjection: "oauth-slots", ...global } }),
	);
	storage.withLock("project", () => JSON.stringify({ anthropicSubscriptionProvider: project }));
	return loadAnthropicSubscriptionProviderSettings(SettingsManager.fromStorage(storage), environment);
}

async function configure(accounts: AccountSlot[] = [primary, secondary]) {
	const store = new InMemoryCredentialStore();
	await store.modify(providerId, async () => ({ ...emptyCredential(), accounts, pinned: "primary" }));
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({}),
		now: () => now,
	});
	return store;
}

function request(
	providerSettings: ReturnType<typeof settings>,
	outcome: (account: string) => string | undefined,
	options: { pinnedAccount?: string; preferredAccount?: string } = {},
) {
	const attempts: string[] = [];
	const query: SdkQuery = ({ options: sdkOptions }) => {
		const account = sdkOptions?.env?.CLAUDE_CODE_OAUTH_TOKEN ?? "missing";
		attempts.push(account);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				const error = outcome(account);
				if (error) throw new Error(error);
				yield {
					type: "system",
					subtype: "compact_boundary",
					uuid: "00000000-0000-4000-8000-000000000001",
					session_id: "account-fallback-test",
					compact_metadata: { trigger: "manual", pre_tokens: 0 },
				};
			},
			async interrupt() {},
			close() {},
		};
	};
	const completion = (async () => {
		const messages: SDKMessage[] = [];
		for await (const message of queryWithAuthLane({
			prompt: "offline account selection",
			query,
			buildOptions: () => ({}),
			providerSettings,
			sessionId: "session-01",
			model: "claude-test",
			...options,
		})) {
			messages.push(message);
		}
		return messages;
	})();
	return { attempts, completion };
}

afterEach(() => {
	// A plain rate limit is held per session in process memory (senpi#3466); every case reuses one session.
	for (const name of ["primary", "secondary", "alpha", "bravo"]) forgetSessionBlocksFor(name);
	resetAuthLaneBoundary();
	vi.useRealTimers();
});

describe("Anthropic account fallback opt-out", () => {
	it.each(["rate_limit", "authentication_failed", "billing_error"])(
		"surfaces %s without spending a sibling account",
		async (failure) => {
			await configure();
			const run = request(settings({ accountFallback: false }), (account) =>
				account === "primary" ? failure : undefined,
			);
			await expect(run.completion).rejects.toMatchObject({ name: "ClassifiedSdkError" });
			expect(run.attempts).toEqual(["primary"]);
		},
	);

	it.each([undefined, true])("preserves automatic switching with accountFallback=%s", async (accountFallback) => {
		await configure();
		const run = request(settings({ accountFallback }), (account) =>
			account === "primary" ? "rate_limit" : undefined,
		);
		await expect(run.completion).resolves.toHaveLength(1);
		expect(run.attempts).toEqual(["primary", "secondary"]);
	});

	it("does not skip a pinned account that was blocked by an earlier request", async () => {
		await configure([{ ...primary, blockReason: "rate_limit", blockedUntil: now + 60_000 }, secondary]);
		const run = request(settings({ accountFallback: false }), () => undefined);
		await expect(run.completion).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		expect(run.attempts).toEqual([]);
	});

	it("keeps an unpinned session on its blocked resident account", async () => {
		const store = await configure([primary, { ...secondary, blockReason: "rate_limit", blockedUntil: now + 60_000 }]);
		await store.modify(providerId, async () => ({
			...emptyCredential(),
			accounts: [primary, { ...secondary, blockReason: "rate_limit", blockedUntil: now + 60_000 }],
		}));
		const run = request(settings({ accountFallback: false }), () => undefined, {
			preferredAccount: "secondary",
		});
		await expect(run.completion).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		expect(run.attempts).toEqual([]);
	});

	it("still permits an explicit request-scoped account selection", async () => {
		await configure([{ ...primary, blockReason: "rate_limit", blockedUntil: now + 60_000 }, secondary]);
		const run = request(settings({ accountFallback: false }), () => undefined, { pinnedAccount: "secondary" });
		await expect(run.completion).resolves.toHaveLength(1);
		expect(run.attempts).toEqual(["secondary"]);
	});

	it("does not skip the blocked deterministic winner before a session has a resident account", async () => {
		const store = await configure();
		await store.modify(providerId, async () => ({
			...emptyCredential(),
			accounts: [
				{ ...primary, name: "alpha", blockReason: "rate_limit", blockedUntil: now + 60_000 },
				{ ...secondary, name: "bravo" },
			],
		}));
		// session-01 selects alpha in the existing affinity golden contract.
		const run = request(settings({ accountFallback: false }), () => undefined);
		await expect(run.completion).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		expect(run.attempts).toEqual([]);
	});

	it("fails closed when the explicitly selected account is missing", async () => {
		await configure();
		const run = request(settings({ accountFallback: false }), () => undefined, { pinnedAccount: "missing" });
		await expect(run.completion).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		expect(run.attempts).toEqual([]);
	});

	it("does not use ambient credentials when the managed pool is empty", async () => {
		await configure([]);
		const run = request(settings({ accountFallback: false }), () => undefined);
		await expect(run.completion).rejects.toBeInstanceOf(Error);
		expect(run.attempts).toEqual([]);
	});

	it("still retries a transient failure on the same account", async () => {
		vi.useFakeTimers();
		await configure();
		let failures = 0;
		const run = request(settings({ accountFallback: false }), () => (failures++ === 0 ? "overloaded" : undefined));
		const completed = expect(run.completion).resolves.toHaveLength(1);
		await vi.runAllTimersAsync();
		await completed;
		expect(run.attempts).toEqual(["primary", "primary"]);
	});

	it.each([
		{ global: true, project: false, environment: {}, switches: false },
		{ global: false, project: true, environment: {}, switches: true },
		{ global: true, project: true, environment: { SENPI_CLAUDE_SDK_OAUTH_ACCOUNT_FALLBACK: "0" }, switches: false },
		{
			global: false,
			project: false,
			environment: { SENPI_CLAUDE_SDK_OAUTH_ACCOUNT_FALLBACK: "true" },
			switches: true,
		},
		{
			global: false,
			project: "invalid",
			environment: { SENPI_CLAUDE_SDK_OAUTH_ACCOUNT_FALLBACK: "invalid" },
			switches: false,
		},
	])("applies setting precedence at the authenticated request boundary: %j", async (fixture) => {
		await configure();
		const run = request(
			settings({ accountFallback: fixture.global }, { accountFallback: fixture.project }, fixture.environment),
			(account) => (account === "primary" ? "rate_limit" : undefined),
		);
		if (fixture.switches) {
			await expect(run.completion).resolves.toHaveLength(1);
			expect(run.attempts).toEqual(["primary", "secondary"]);
		} else {
			await expect(run.completion).rejects.toMatchObject({ name: "ClassifiedSdkError" });
			expect(run.attempts).toEqual(["primary"]);
		}
	});
});
