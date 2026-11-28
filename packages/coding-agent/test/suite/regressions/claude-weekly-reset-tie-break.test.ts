import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preferHeadroom } from "../../../src/core/credential-pool/selection-order.ts";
import type { AccountSlot } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	rendezvousOrder,
	selectAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { loadAnthropicSubscriptionProviderSettings } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";
import { SubscriptionLimitStore, subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import { claudeWindowsFromSdkEvent } from "../../../src/core/subscription-limits/limit-windows.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";

const NOW = Date.parse("2026-11-18T00:00:00.000Z");
const accounts: AccountSlot[] = [cliSlot("alpha"), cliSlot("beta"), cliSlot("gamma")];
const key = "weekly-reset-tie-break";
const ordered = rendezvousOrder(key, accounts);
const [first, second, third] = ordered;
if (first === undefined || second === undefined || third === undefined) {
	throw new Error("weekly reset fixture needs three ordered accounts");
}

type WeeklyOptions = {
	readAgeMinutes?: number;
	scopedUsedPercent?: number;
	scopedResetHours?: number;
	shortUsedPercent?: number;
	shortResetHours?: number;
};

function weekly(account: string, usedPercent: number, resetHours: number, options: WeeklyOptions = {}) {
	return {
		provider: "anthropic-subscription",
		account,
		reportedAt: new Date(NOW - (options.readAgeMinutes ?? 0) * 60_000).toISOString(),
		windows: [
			{
				id: "claude:7d",
				label: "7d",
				windowMinutes: 10_080,
				usedPercent,
				resetsAt: new Date(NOW + resetHours * 60 * 60_000).toISOString(),
			},
			...(options.scopedUsedPercent === undefined
				? []
				: [
						{
							id: "claude:7d_opus",
							label: "7d opus",
							windowMinutes: 10_080,
							usedPercent: options.scopedUsedPercent,
							resetsAt: new Date(NOW + (options.scopedResetHours ?? resetHours) * 60 * 60_000).toISOString(),
						},
					]),
			...(options.shortUsedPercent === undefined
				? []
				: [
						{
							id: "claude:5h",
							label: "5h",
							windowMinutes: 300,
							usedPercent: options.shortUsedPercent,
							resetsAt: new Date(NOW + (options.shortResetHours ?? 1) * 60 * 60_000).toISOString(),
						},
					]),
		],
	};
}

function settings(global: unknown, project: unknown = {}): SettingsManager {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ anthropicSubscriptionProvider: global }));
	storage.withLock("project", () => JSON.stringify({ anthropicSubscriptionProvider: project }));
	return SettingsManager.fromStorage(storage);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([]);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Claude weekly reset tie-break", () => {
	it("loads as opt-in and obeys project-over-global precedence", () => {
		expect(loadAnthropicSubscriptionProviderSettings(settings({ weeklyResetTieBreak: true }), {})).toMatchObject({
			weeklyResetTieBreak: true,
		});
		expect(
			loadAnthropicSubscriptionProviderSettings(
				settings({ weeklyResetTieBreak: true }, { weeklyResetTieBreak: false }),
				{},
			),
		).toMatchObject({ weeklyResetTieBreak: false });
	});

	it("swaps only the first two accounts at the five-point and 24-hour boundaries", () => {
		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(first.name, 40, 48),
			weekly(second.name, 45, 24),
			weekly(third.name, 40, 1),
		]);
		expect(selectAccount(accounts, { sessionId: key, now: NOW }).name).toBe(first.name);
		expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(second.name);
		expect(
			preferHeadroom(ordered, "anthropic-subscription", subscriptionLimits.snapshot(), NOW, undefined, true).map(
				(account) => account.name,
			),
		).toEqual([second.name, first.name, third.name]);

		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(first.name, 40.9, 48),
			weekly(second.name, 46.1, 24),
		]);
		expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(first.name);

		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(first.name, 40, 48, { readAgeMinutes: 15 }),
			weekly(second.name, 45, 24, { readAgeMinutes: 15 }),
		]);
		expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(second.name);

		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(first.name, 40, 48, { readAgeMinutes: -1 }),
			weekly(second.name, 45, 24, { readAgeMinutes: -1 }),
		]);
		expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(second.name);

		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(first.name, 40, 24),
			weekly(second.name, 45, 24),
		]);
		expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(first.name);

		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(first.name, 40, 48),
			weekly(second.name, 45, 25),
		]);
		expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(first.name);
	});

	it("uses the highest weekly window and requires every live window to remain tied", () => {
		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(first.name, 20, 20, { scopedUsedPercent: 50 }),
			weekly(second.name, 20, 20, { scopedUsedPercent: 54, scopedResetHours: 2 }),
		]);
		expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(second.name);

		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(first.name, 50, 48, { scopedUsedPercent: 50, scopedResetHours: 20 }),
			weekly(second.name, 50, 24, { scopedUsedPercent: 50, scopedResetHours: 2 }),
		]);
		expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(second.name);

		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(first.name, 40, 48, { shortUsedPercent: 80, shortResetHours: -1 }),
			weekly(second.name, 45, 24, { shortUsedPercent: 5 }),
		]);
		expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(second.name);

		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(first.name, 40, 20, { shortUsedPercent: 10 }),
			weekly(second.name, 45, 2, { shortUsedPercent: 60 }),
		]);
		expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(first.name);
	});

	it("does not refresh stale weekly readings when only the five-hour window updates", () => {
		const store = new SubscriptionLimitStore();
		const recordCompleteReading = (account: string, weeklyResetHours: number) => {
			store.record(
				"anthropic-subscription",
				account,
				weekly(account, 40, weeklyResetHours, { shortUsedPercent: 10, shortResetHours: 3 }).windows,
				new Date(NOW),
			);
		};
		recordCompleteReading(first.name, 48);
		recordCompleteReading(second.name, 12);
		vi.mocked(subscriptionLimits.snapshot).mockImplementation(() => store.snapshot());

		expect(
			selectAccount(accounts, { sessionId: key, now: NOW + 60_000, weeklyResetTieBreak: true }).name,
			"control: a fresh tied weekly reading prefers the earlier reset",
		).toBe(second.name);
		expect(
			selectAccount(accounts, { sessionId: key, now: NOW + 60 * 60_000, weeklyResetTieBreak: true }).name,
			"guard: the hour-old weekly reading keeps the affinity order",
		).toBe(first.name);

		vi.setSystemTime(NOW + 60 * 60_000);
		for (const account of [first.name, second.name]) {
			store.record(
				"anthropic-subscription",
				account,
				claudeWindowsFromSdkEvent({
					type: "rate_limit_event",
					rate_limit_info: {
						rateLimitType: "five_hour",
						utilization: 0.12,
						resetsAt: Math.floor((NOW + 3 * 60 * 60_000) / 1000),
					},
				}),
			);
		}

		expect(
			selectAccount(accounts, { sessionId: key, now: NOW + 61 * 60_000, weeklyResetTieBreak: true }).name,
			"the weekly readings are still 61 minutes old",
		).toBe(first.name);
	});

	it("preserves order for stale, expired, missing, near-limit, resident, pinned, ordered, and blocked cases", () => {
		const unchanged = (limits: ReturnType<typeof weekly>[]) => {
			vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue(limits);
			expect(selectAccount(accounts, { sessionId: key, now: NOW, weeklyResetTieBreak: true }).name).toBe(first.name);
		};
		unchanged([weekly(first.name, 40, 20, { readAgeMinutes: 16 }), weekly(second.name, 45, 2)]);
		unchanged([weekly(first.name, 40, 20), weekly(second.name, 45, -1)]);
		unchanged([weekly(second.name, 45, 2)]);
		unchanged([weekly(first.name, 90, 20), weekly(second.name, 95, 2)]);
		unchanged([weekly(first.name, 40, 48), weekly(second.name, 45, 25)]);
		unchanged([weekly(first.name, 96, 48), weekly(second.name, 97, 2), weekly(third.name, 98, 1)]);

		const live = [weekly(first.name, 40, 20), weekly(second.name, 45, 2)];
		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue(live);
		expect(
			selectAccount(accounts, { sessionId: key, now: NOW, pinnedAccount: third.name, weeklyResetTieBreak: true })
				.name,
		).toBe(third.name);
		expect(
			selectAccount(accounts, {
				sessionId: key,
				now: NOW,
				preferredAccount: first.name,
				weeklyResetTieBreak: true,
			}).name,
		).toBe(first.name);
		expect(
			selectAccount(accounts, {
				sessionId: key,
				now: NOW,
				accountOrder: [first.name, second.name],
				weeklyResetTieBreak: true,
			}).name,
		).toBe(first.name);
		expect(
			selectAccount(accounts, {
				sessionId: key,
				now: NOW,
				accountOrder: [],
				weeklyResetTieBreak: true,
			}).name,
		).toBe(second.name);

		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			weekly(second.name, 40, 48),
			weekly(third.name, 45, 2),
		]);
		expect(
			selectAccount(
				accounts.map((account) =>
					account.name === first.name ? { ...account, blockedUntil: NOW + 60_000 } : account,
				),
				{ sessionId: key, now: NOW, preferredAccount: first.name, weeklyResetTieBreak: true },
			).name,
		).toBe(third.name);
	});
});
