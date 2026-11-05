/**
 * senpi#5627: a poll that has nothing to ask with (a claude CLI account on macOS, or any expired token) caches a
 * placeholder so it looks again next interval. That placeholder is not an answer: adopting it must never replace the
 * windows a turn's `rate_limit_event` already recorded for the account.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubscriptionLimitStore } from "../../../src/core/subscription-limits/limit-store.ts";
import type { PollAccount } from "../../../src/core/subscription-limits/usage-accounts.ts";
import { UsagePoller } from "../../../src/core/subscription-limits/usage-poller.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function cachePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-5627-placeholder-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "subscription-usage.json");
}

const noToken: PollAccount = { provider: "anthropic-subscription", account: "cli", access: async () => undefined };
const turnWindow = { id: "claude:5h", label: "5h", usedPercent: 63 };

function pollerFor(store: SubscriptionLimitStore, path: string, now: number): UsagePoller {
	return new UsagePoller({
		store,
		cachePath: path,
		listAccounts: async () => [noToken],
		fetch: async () => {
			throw new Error("no request is made without a token");
		},
		now: () => now,
	});
}

describe("a placeholder poll reading", () => {
	it("keeps the windows a turn recorded before the first poll", async () => {
		const store = new SubscriptionLimitStore();
		store.record("anthropic-subscription", "cli", [turnWindow], new Date(1_000));

		await pollerFor(store, cachePath(), 2_000).pollOnce();

		expect(store.snapshot()).toEqual([expect.objectContaining({ account: "cli", windows: [turnWindow] })]);
	});

	it("keeps them in a sibling process that adopts the cached placeholder", async () => {
		const path = cachePath();
		await pollerFor(new SubscriptionLimitStore(), path, 2_000).pollOnce();
		const sibling = new SubscriptionLimitStore();
		sibling.record("anthropic-subscription", "cli", [turnWindow], new Date(1_000));

		await pollerFor(sibling, path, 3_000).pollOnce();

		expect(sibling.snapshot()).toEqual([expect.objectContaining({ account: "cli", windows: [turnWindow] })]);
	});
});
