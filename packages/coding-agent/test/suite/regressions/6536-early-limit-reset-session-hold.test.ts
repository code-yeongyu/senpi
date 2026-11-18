import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptOptions } from "../../../src/core/agent-session.ts";
import { subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#6536: a Claude subscription limit states its reset ("resets in 2 hours"), so the session holds the provider
// until then and a person's turn does not re-ask (senpi#5568 re-asks only a guessed hold). The user then resets the
// account's usage early. Usage the provider reports after the hold began, under every limit, must release it.
// The limit store is process-wide: each case runs at a later epoch than the one before, so an earlier case's
// reading is always older than a later case's hold.
const PROVIDER = "anthropic-subscription";
const HOUR = 60 * 60_000;
const SESSION_LIMIT = "You've hit your session limit · resets in 2 hours";

function reportUsage(account: string, usedPercent: number, at: number): void {
	subscriptionLimits.report(PROVIDER, account, {
		windows: [
			{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent, resetsAt: new Date(at + HOUR).toISOString() },
		],
		reportedAt: new Date(at),
	});
}

describe("a held Claude subscription serves again once its usage shows the limit was reset early (senpi#6536)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		vi.useRealTimers();
	});

	async function heldSession(epoch: number): Promise<Harness> {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(epoch);
		const harness = await createHarness({
			provider: PROVIDER,
			fallbackNow: () => Date.now(),
			fallbackWallNow: () => Date.now(),
			settings: { retry: { enabled: true, maxRetries: 0 }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: SESSION_LIMIT })]);
		await harness.session.prompt("first");
		expect(harness.faux.getCallLog()).toHaveLength(1);
		vi.setSystemTime(epoch + 10 * 60_000);
		return harness;
	}

	it.each<{ name: string; epoch: number; options: PromptOptions }>([
		{ name: "a person's turn", epoch: Date.UTC(2026, 10, 12, 1), options: {} },
		{ name: "an automated turn", epoch: Date.UTC(2026, 10, 12, 2), options: { source: "extension" } },
	])("$name runs once newer usage is under every limit", async ({ epoch, options }) => {
		const harness = await heldSession(epoch);
		reportUsage(`reset-${epoch}`, 0, Date.now());
		harness.setResponses([fauxAssistantMessage("served after the early reset")]);

		await harness.session.prompt("continue", options);

		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			content: [expect.objectContaining({ text: "served after the early reset" })],
		});
	});

	it.each<{ name: string; epoch: number; usedPercent: number; readAgo: number }>([
		{
			name: "no reading newer than the hold",
			epoch: Date.UTC(2026, 10, 12, 3),
			usedPercent: 0,
			readAgo: 20 * 60_000,
		},
		{ name: "a newer reading still at the limit", epoch: Date.UTC(2026, 10, 12, 4), usedPercent: 100, readAgo: 0 },
	])("keeps the hold with $name, and sends nothing", async ({ epoch, usedPercent, readAgo }) => {
		const harness = await heldSession(epoch);
		reportUsage(`held-${epoch}`, usedPercent, Date.now() - readAgo);

		const refusal = harness.session.prompt("continue");

		await expect(refusal).rejects.toMatchObject({ name: "AccountUsageLimitError" });
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});
});
