import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AccountSlot } from "../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { selectAccount } from "../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { classifySdkError } from "../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import { runFailover } from "../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import { cliSlot } from "../support/claude-cli-test-slots.ts";

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
	const events: string[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

// PR #3916: reset waiting is bounded, abortable, and never replaces auth or model-fallback handling.
describe("Anthropic Subscription limit-reset wait", () => {
	it.each(["already blocked", "new exhaustion", "partially blocked"])(
		"resumes once after %s at the nearest reset",
		async (scenario) => {
			let now = 10_000;
			const accounts: AccountSlot[] = [cliSlot("first"), cliSlot("second")].map((account, index) => ({
				...account,
				...(scenario === "already blocked" || (scenario === "partially blocked" && index === 1)
					? { blockReason: "rate_limit", blockedUntil: now + 500 + index * 500 }
					: {}),
			}));
			const attempts: string[] = [];
			const sleep = vi.fn(async (ms: number) => {
				now += ms;
			});
			const events = await collect(
				runFailover({
					accounts,
					selectFn: (pool) => selectAccount(pool, { now, accountOrder: ["first", "second"] }),
					runAttempt: async function* (slot) {
						attempts.push(slot.name);
						if (scenario !== "already blocked" && now === 10_000)
							throw new Error("You've hit your usage limit. retry-after-ms: 500");
						yield slot.name;
					},
					classify: classifySdkError,
					store: new InMemoryCredentialStore(),
					providerId: "anthropic-subscription",
					now: () => now,
					sleep,
				}),
			);
			expect(events).toEqual(["first"]);
			expect(attempts).toEqual(
				scenario === "already blocked"
					? ["first"]
					: scenario === "new exhaustion"
						? ["first", "second", "first"]
						: ["first", "first"],
			);
			expect(sleep.mock.calls).toEqual([[500, undefined]]);
		},
	);

	it("does not wait a second time when the recovered account is exhausted again", async () => {
		let now = 10_000;
		const sleep = vi.fn(async (ms: number) => {
			now += ms;
		});
		const attempt = vi.fn();
		await expect(
			collect(
				runFailover({
					accounts: [cliSlot("only")],
					selectFn: (pool) => selectAccount(pool, { now }),
					runAttempt: async function* () {
						attempt();
						yield* [];
						throw new Error("You've hit your usage limit. retry-after-ms: 500");
					},
					classify: classifySdkError,
					store: new InMemoryCredentialStore(),
					providerId: "anthropic-subscription",
					now: () => now,
					sleep,
				}),
			),
		).rejects.toMatchObject({ name: "ClassifiedSdkError", classification: { kind: "rate_limit" } });
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(attempt).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ reason: "auth_error", wait: 500 },
		{ reason: "billing", wait: 500 },
		{ reason: "rate_limit", wait: 18_000_001 },
		{ reason: "rate_limit", wait: 500, model: "claude-test" },
		{ reason: "rate_limit", wait: 500, persistBlocks: false },
	])("preserves the typed refusal without waiting: %j", async ({ reason, wait, model, persistBlocks }) => {
		const sleep = vi.fn();
		const attempt = vi.fn();
		const account = {
			...cliSlot("blocked"),
			...(model === undefined
				? { blockReason: reason, blockedUntil: 10_000 + wait }
				: { modelBlocks: { [model]: { blockedUntil: 10_000 + wait } } }),
		};
		await expect(
			collect(
				runFailover({
					accounts: [account],
					selectFn: (pool) => selectAccount(pool, { now: 10_000, model }),
					runAttempt: async function* () {
						attempt();
						yield "unexpected";
					},
					classify: classifySdkError,
					store: new InMemoryCredentialStore(),
					providerId: "anthropic-subscription",
					now: () => 10_000,
					model,
					persistBlocks,
					sleep,
				}),
			),
		).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		expect(sleep).not.toHaveBeenCalled();
		expect(attempt).not.toHaveBeenCalled();
	});

	it("cancels the real reset timer without dispatching another attempt", async () => {
		const controller = new AbortController();
		const attempt = vi.fn();
		const stream = runFailover({
			accounts: [{ ...cliSlot("blocked"), blockReason: "rate_limit", blockedUntil: 10_500 }],
			selectFn: (pool) => selectAccount(pool, { now: 10_000 }),
			runAttempt: async function* () {
				attempt();
				yield "unexpected";
			},
			classify: classifySdkError,
			store: new InMemoryCredentialStore(),
			providerId: "anthropic-subscription",
			now: () => 10_000,
			signal: controller.signal,
		});
		const result = expect(collect(stream)).rejects.toMatchObject({ name: "AllAccountsBlockedError" });
		controller.abort();
		await result;
		expect(attempt).not.toHaveBeenCalled();
	});
});
