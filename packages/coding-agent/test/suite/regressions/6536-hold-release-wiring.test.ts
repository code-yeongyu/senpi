import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#6540 reviews (LOW): only the helper was tested, so the session could read the raw snapshot again and every
// test would pass. This drives the turn gate on the Claude lane's real account shape: a held provider whose pool is an
// account the user must bring back and an account waiting on its limit. Usage from the first must not release the
// hold; usage from the second must. The limit store is process-wide, so each case uses its own names and epoch.
const PROVIDER = "anthropic-subscription";
const HOUR = 60 * 60_000;
const SESSION_LIMIT = "You've hit your session limit · resets in 2 hours";

function reportCapacity(account: string, at: number): void {
	subscriptionLimits.report(PROVIDER, account, {
		windows: [
			{
				id: "claude:5h",
				label: "5h",
				windowMinutes: 300,
				usedPercent: 0,
				resetsAt: new Date(at + HOUR).toISOString(),
			},
		],
		reportedAt: new Date(at),
	});
}

describe("the turn gate reads only usage from accounts the pool can select (senpi#6536)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		vi.useRealTimers();
	});

	async function heldPool(
		epoch: number,
		outReason: string,
	): Promise<{ harness: Harness; out: string; limited: string }> {
		const out = `wire-out-${epoch}`;
		const limited = `wire-limited-${epoch}`;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(epoch);
		const harness = await createHarness({
			provider: PROVIDER,
			fallbackNow: () => Date.now(),
			fallbackWallNow: () => Date.now(),
			settings: { retry: { enabled: true, maxRetries: 0 }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const slots = [
			cliSlot(out, { blockReason: outReason, blockedUntil: epoch + 2 * HOUR, blockedAt: epoch }),
			cliSlot(limited, { blockReason: "rate_limit", blockedUntil: epoch + 2 * HOUR, blockedAt: epoch }),
		];
		await harness.authStorage.modify(PROVIDER, async () =>
			slots.reduce<AnthropicSubscriptionCredential>(
				(credential, slot) => addAccount(credential, slot),
				emptyCredential(),
			),
		);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: SESSION_LIMIT })]);
		await harness.session.prompt("first");
		expect(harness.faux.getCallLog()).toHaveLength(1);
		vi.setSystemTime(epoch + 10 * 60_000);
		return { harness, out, limited };
	}

	it.each<{ name: string; epoch: number; outReason: string }>([
		{ name: "a disabled account", epoch: Date.UTC(2026, 10, 12, 8), outReason: "account_disabled" },
		{ name: "a billing-blocked account", epoch: Date.UTC(2026, 10, 12, 9), outReason: "billing" },
	])("keeps the hold when only $name reports capacity, and sends nothing", async ({ epoch, outReason }) => {
		const { harness, out } = await heldPool(epoch, outReason);
		reportCapacity(out, Date.now());

		await expect(harness.session.prompt("continue", { source: "extension" })).rejects.toMatchObject({
			name: "AccountUsageLimitError",
		});
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("releases the hold when the account waiting on its limit reports capacity", async () => {
		const { harness, limited } = await heldPool(Date.UTC(2026, 10, 12, 10), "account_disabled");
		reportCapacity(limited, Date.now());
		harness.setResponses([fauxAssistantMessage("served after the early reset")]);

		await harness.session.prompt("continue", { source: "extension" });

		expect(harness.faux.getCallLog()).toHaveLength(2);
	});
});
