/**
 * senpi#3684: subscription limits are known before the first turn. The engine polls each signed-in
 * account's usage endpoint into the same store turns report into, so a fresh host answers
 * `get_subscription_limits` with windows, the SDK `rate_limit_event` lands in that account's one record,
 * sibling processes sharing the cache file make one request, and extensions read the same records.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { SubscriptionLimitStore, subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import { claudeWindowsFromSdkEvent } from "../../../src/core/subscription-limits/limit-windows.ts";
import type { PollAccount } from "../../../src/core/subscription-limits/usage-accounts.ts";
import { readUsageCache, withResults } from "../../../src/core/subscription-limits/usage-cache.ts";
import {
	CLAUDE_USAGE_URL,
	type UsageFetch,
	UsageHttpError,
} from "../../../src/core/subscription-limits/usage-endpoints.ts";
import { UsagePoller } from "../../../src/core/subscription-limits/usage-poller.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

const CLAUDE_PAYLOAD = {
	limits: [
		{ kind: "session", percent: 41, resets_at: "2026-10-19T09:00:00Z" },
		{ kind: "weekly_all", percent: 12, resets_at: "2026-10-24T00:00:00Z" },
	],
};
const CODEX_PAYLOAD = {
	plan_type: "pro",
	rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18_000, reset_at: 1_792_400_000 } },
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function cachePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-3684-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "subscription-usage.json");
}

function account(provider: PollAccount["provider"], name: string, access = "x".repeat(48)): PollAccount {
	return { provider, account: name, access: async () => ({ access }) };
}

function countingFetch(answer: (url: string) => unknown): { fetch: UsageFetch; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		fetch: async (url) => {
			calls.push(url);
			const value = answer(url);
			if (value instanceof Error) throw value;
			return value;
		},
	};
}

const payloads = (url: string) => (url === CLAUDE_USAGE_URL ? CLAUDE_PAYLOAD : CODEX_PAYLOAD);

describe("subscription limits before the first turn (senpi#3684)", () => {
	it("a fresh host answers get_subscription_limits with polled windows before any prompt", async () => {
		const { fetch } = countingFetch(payloads);
		const poller = new UsagePoller({
			store: subscriptionLimits,
			cachePath: cachePath(),
			listAccounts: async () => [
				account("anthropic-subscription", "poll-3684-claude"),
				account("chatgpt-subscription", "poll-3684-codex"),
			],
			fetch,
			now: () => Date.parse("2026-10-19T04:00:00Z"),
		});
		const lines: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("c1", { writeRaw: (chunk) => lines.push(chunk), waitForBackpressure: async () => {} });
		const router = new SessionCommandRouter({ list: () => [] } as never, writer, { cwd: "/tmp" });
		try {
			await poller.pollOnce();
			const answer = await router.handle({ id: "q", type: "get_subscription_limits" });
			const accounts = (answer as { data: { accounts: unknown[] } }).data.accounts;

			expect(accounts).toContainEqual(
				expect.objectContaining({
					provider: "anthropic-subscription",
					account: "poll-3684-claude",
					windows: [
						expect.objectContaining({ id: "claude:5h", label: "5h", usedPercent: 41 }),
						expect.objectContaining({ id: "claude:7d", label: "7d", usedPercent: 12 }),
					],
				}),
			);
			expect(accounts).toContainEqual(
				expect.objectContaining({
					provider: "chatgpt-subscription",
					account: "poll-3684-codex",
					plan: "pro",
					windows: [expect.objectContaining({ id: "codex:primary", label: "5h", usedPercent: 7 })],
				}),
			);
			subscriptionLimits.report("anthropic-subscription", "poll-3684-claude", {
				error: "rate limited",
				reportedAt: new Date("2026-10-19T04:05:00Z"),
			});
			await writer.flush();
			const records = lines
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			expect(records).toContainEqual(
				expect.objectContaining({
					type: "subscription_limits",
					account: "poll-3684-claude",
					error: "rate limited",
					windows: [expect.objectContaining({ id: "claude:5h" }), expect.objectContaining({ id: "claude:7d" })],
				}),
			);
		} finally {
			await router.dispose();
		}
	});

	it("folds a turn's rate_limit_event into the polled account's one record", async () => {
		const store = new SubscriptionLimitStore();
		const { fetch } = countingFetch(payloads);
		await new UsagePoller({
			store,
			cachePath: cachePath(),
			listAccounts: async () => [account("anthropic-subscription", "work")],
			fetch,
			now: () => 1_000,
		}).pollOnce();
		store.record(
			"anthropic-subscription",
			"work",
			claudeWindowsFromSdkEvent({
				type: "rate_limit_event",
				rate_limit_info: { rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1_792_400_000 },
			}),
		);

		expect(store.snapshot()).toHaveLength(1);
		expect(store.snapshot()[0]?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
			["claude:5h", 50],
			["claude:7d", 12],
		]);
	});

	it("two processes sharing the cache make one request per account; the second adopts the reading", async () => {
		const path = cachePath();
		const { fetch, calls } = countingFetch(payloads);
		const first = new SubscriptionLimitStore();
		const second = new SubscriptionLimitStore();
		const deps = { cachePath: path, listAccounts: async () => [account("anthropic-subscription", "work")], fetch };
		await new UsagePoller({ ...deps, store: first, now: () => 1_000 }).pollOnce();
		await new UsagePoller({ ...deps, store: second, now: () => 61_000 }).pollOnce();

		expect(calls).toEqual([CLAUDE_USAGE_URL]);
		expect(second.snapshot()).toEqual(first.snapshot());
	});

	it("a refused poll keeps the last windows, says why, and backs off", async () => {
		const path = cachePath();
		const store = new SubscriptionLimitStore();
		let refuse: Error | undefined;
		const { fetch, calls } = countingFetch(() => refuse ?? CLAUDE_PAYLOAD);
		let now = 0;
		const poller = new UsagePoller({
			store,
			cachePath: path,
			listAccounts: async () => [account("anthropic-subscription", "work")],
			fetch,
			now: () => now,
		});
		await poller.pollOnce();
		refuse = new UsageHttpError(401, undefined);
		now = 300_000;
		await poller.pollOnce();
		now = 600_000;
		await poller.pollOnce();

		expect(calls).toHaveLength(2);
		expect(store.snapshot()[0]).toMatchObject({
			error: "auth stale - run /login",
			windows: [{ id: "claude:5h" }, { id: "claude:7d" }],
		});
		expect(readUsageCache(path).accounts["anthropic-subscription/work"]?.nextAt).toBe(300_000 + 5 * 300_000);

		refuse = new UsageHttpError(429, 90_000);
		now = 1_800_000;
		await poller.pollOnce();
		expect(store.snapshot()[0]?.error).toBe("rate limited");
		expect(readUsageCache(path).accounts["anthropic-subscription/work"]?.nextAt).toBe(1_800_000 + 90_000);
	});

	// senpi#3695: a process adopting the cache fresh after a failed poll still sees the account's plan.
	it("a failed poll keeps the last plan in the shared cache, as it keeps the windows", () => {
		const key = "chatgpt-subscription/default";
		const windows = [{ id: "codex:5h", label: "5h", windowMinutes: 300, usedPercent: 12 }];
		const cache = {
			accounts: { [key]: { windows, plan: "pro", updatedAt: 1_000, nextAt: 301_000 } },
			fetching: { [key]: { token: "claim", claimedAt: 301_000 } },
		} as never;
		const failed = new Map([[key, { windows: [], error: "rate limited", updatedAt: 301_000, nextAt: 391_000 }]]);

		expect(withResults(cache, failed, "claim").accounts[key]).toMatchObject({
			windows,
			plan: "pro",
			error: "rate limited",
		});
	});

	it("newest report wins in both arrival orders: an older poll never replaces a newer turn", () => {
		const turn = (store: SubscriptionLimitStore, at: number) =>
			store.record(
				"anthropic-subscription",
				"work",
				[{ id: "claude:5h", label: "5h", usedPercent: 70 }],
				new Date(at),
			);
		const poll = (store: SubscriptionLimitStore, at: number) =>
			store.report("anthropic-subscription", "work", {
				windows: [{ id: "claude:5h", label: "5h", usedPercent: 20 }],
				reportedAt: new Date(at),
			});
		const shown = (store: SubscriptionLimitStore) => store.snapshot()[0]?.windows[0]?.usedPercent;

		const olderPollLate = new SubscriptionLimitStore();
		turn(olderPollLate, 5_000);
		poll(olderPollLate, 1_000);
		const newerPollLate = new SubscriptionLimitStore();
		turn(newerPollLate, 1_000);
		poll(newerPollLate, 5_000);

		expect([shown(olderPollLate), shown(newerPollLate)]).toEqual([70, 20]);
	});

	it("a sibling's cached poll adopted after a fresher turn does not roll the turn back", async () => {
		const path = cachePath();
		const { fetch } = countingFetch(payloads);
		const deps = { cachePath: path, listAccounts: async () => [account("anthropic-subscription", "work")], fetch };
		await new UsagePoller({ ...deps, store: new SubscriptionLimitStore(), now: () => 1_000 }).pollOnce();
		const late = new SubscriptionLimitStore();
		late.record(
			"anthropic-subscription",
			"work",
			[{ id: "claude:5h", label: "5h", usedPercent: 88 }],
			new Date(30_000),
		);

		await new UsagePoller({ ...deps, store: late, now: () => 31_000 }).pollOnce();

		expect(late.snapshot()[0]?.windows.map((window) => [window.id, window.usedPercent])).toEqual([["claude:5h", 88]]);
	});

	it("extensions read and subscribe to the same records", async () => {
		let api: ExtensionAPI | undefined;
		const harness: Harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					api = pi;
				},
			],
		});
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		if (!api) throw new Error("the probe extension did not load");
		const heard: string[] = [];
		const stop = api.onSubscriptionLimits((limits) => heard.push(limits.account));
		subscriptionLimits.report("anthropic-subscription", "ext-3684", {
			windows: [{ id: "claude:5h", label: "5h", usedPercent: 3 }],
			reportedAt: new Date(0),
		});
		stop();

		expect(heard).toEqual(["ext-3684"]);
		expect(api.getSubscriptionLimits()).toContainEqual(expect.objectContaining({ account: "ext-3684" }));
	});
});
