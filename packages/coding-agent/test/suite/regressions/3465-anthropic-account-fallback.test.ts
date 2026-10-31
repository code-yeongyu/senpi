// Issue #3465: disabling model fallback must not be the only way to control account spending.
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AccountSlot,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { selectAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { forgetSessionBlocksFor } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import type { SDKMessage, SdkQuery } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { loadAnthropicSubscriptionProviderSettings } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { withAuthGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-guidance.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";
import { cliAccountOf, cliLaneEnv, cliSlot } from "../../support/claude-cli-test-slots.ts";

const now = 1_800_000_000_000;
const providerId = "anthropic-subscription";
const primary: AccountSlot = cliSlot("primary");
const secondary: AccountSlot = cliSlot("secondary");

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
		env: () => cliLaneEnv(),
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
		const account = cliAccountOf(sdkOptions?.env);
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

/** What the user sees for a rejected turn: the lane's guidance, not the raw error. */
async function shownGuidance(completion: Promise<unknown>): Promise<string> {
	const error = await completion.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	if (!(error instanceof Error)) throw new Error("expected the turn to be rejected");
	return withAuthGuidance(error, error.message);
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
		// The healthy sibling is never used, so the advice names this account and the remedies that apply.
		const shown = await shownGuidance(run.completion);
		expect(shown).toContain("Claude account 'primary'");
		expect(shown).toContain(`until ${new Date(now + 60_000).toISOString()}`);
		expect(shown).toContain("account fallback is off");
		expect(shown).toContain("/claude-account pin");
		expect(shown).toContain("accountFallback: true");
		expect(shown).not.toContain("All Claude accounts");
		expect(shown).not.toContain("add another account");
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

	it("keeps the head of the user's account order instead of skipping it when it is blocked", () => {
		// senpi#3591 lets the user order accounts; with fallback off, that order picks the one account.
		const accounts = [
			{ ...primary, name: "alpha" },
			{ ...secondary, name: "bravo", blockReason: "rate_limit", blockedUntil: now + 60_000 },
		];
		const options = { sessionId: "session-01", accountOrder: ["bravo", "alpha"], now };
		expect(selectAccount(accounts, options).name).toBe("alpha");
		const error = (() => {
			try {
				selectAccount(accounts, { ...options, accountFallback: false });
			} catch (thrown) {
				return thrown;
			}
		})();
		expect(error).toMatchObject({ name: "AllAccountsBlockedError", unavailableAccount: { name: "bravo" } });
		expect(withAuthGuidance(error, "")).toContain("Claude account 'bravo'");
	});

	it("fails closed when the explicitly selected account is missing", async () => {
		await configure();
		const run = request(settings({ accountFallback: false }), () => undefined, { pinnedAccount: "missing" });
		await expect(run.completion).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		expect(run.attempts).toEqual([]);
		const shown = await shownGuidance(run.completion);
		expect(shown).toContain("Claude account 'missing'");
		expect(shown).toContain("is not configured");
		expect(shown).not.toContain("re-login");
	});

	it("names a removed resident account instead of reporting a re-login retry", async () => {
		// session-stream passes the session's account as preferredAccount even after it was removed.
		const store = await configure();
		await store.modify(providerId, async () => ({ ...emptyCredential(), accounts: [primary, secondary] }));
		const run = request(settings({ accountFallback: false }), () => undefined, { preferredAccount: "retired" });
		await expect(run.completion).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		expect(run.attempts).toEqual([]);
		const shown = await shownGuidance(run.completion);
		expect(shown).toContain("Claude account 'retired'");
		expect(shown).toContain("is not configured");
		expect(shown).toContain("Start a new session");
		expect(shown).not.toContain("after re-login");
	});

	it("tells a CLI-pinned session to restart with another --claude-account instead of /claude-account pin", async () => {
		// senpi#3672: a CLI pin outranks the stored pin, so /claude-account pin would change nothing.
		await configure([primary, { ...secondary, blockReason: "rate_limit", blockedUntil: now + 60_000 }]);
		const run = request(settings({ accountFallback: false }), () => undefined, { pinnedAccount: "secondary" });
		await expect(run.completion).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		const shown = await shownGuidance(run.completion);
		expect(shown).toContain("Claude account 'secondary'");
		expect(shown).toContain("--claude-account");
		expect(shown).not.toContain("/claude-account pin");
	});

	it("tells a settings-pinned session to change the setting instead of /claude-account pin", async () => {
		await configure([primary, { ...secondary, blockReason: "rate_limit", blockedUntil: now + 60_000 }]);
		const run = request(settings({ accountFallback: false, pinnedAccount: "secondary" }), () => undefined);
		await expect(run.completion).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		const shown = await shownGuidance(run.completion);
		expect(shown).toContain("Claude account 'secondary'");
		expect(shown).toContain("anthropicSubscriptionProvider.pinnedAccount");
		expect(shown).not.toContain("/claude-account pin");
	});

	it("points an auth-blocked account at /login and calls its time a re-check, not a wait", async () => {
		// senpi#3672: an auth block does not clear by waiting; its time is only when the account is checked again.
		const recheck = now + 60_000;
		await configure([{ ...primary, blockReason: "auth_error", blockedUntil: recheck }, secondary]);
		const run = request(settings({ accountFallback: false }), () => undefined);
		await expect(run.completion).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		const shown = await shownGuidance(run.completion);
		expect(shown).toContain("Claude account 'primary'");
		expect(shown).toContain("authentication error");
		expect(shown).toContain("/login anthropic-subscription");
		expect(shown).toContain(`Next automatic re-check: ${new Date(recheck).toISOString()}`);
		expect(shown).not.toContain("Wait until");
		expect(shown).not.toContain("can serve again");
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
