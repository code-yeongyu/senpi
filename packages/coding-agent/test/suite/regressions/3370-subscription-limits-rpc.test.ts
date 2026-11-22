/**
 * senpi#3370: the limit windows a response reports are kept per provider and credential slot and served
 * over RPC: `get_subscription_limits` answers every account's latest windows (an account nothing reported
 * for is absent - unknown, never 0%), and every connection hears a `subscription_limits` record when they
 * change. Requests feed the store through their `onResponse`, so the caller's own hook still runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	limitAccountOf,
	SubscriptionLimitStore,
	subscriptionLimits,
	withLimitCapture,
} from "../../../src/core/subscription-limits/limit-store.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { getModelRuntime } from "../../model-runtime-test-utils.ts";
import { createHarness } from "../harness.ts";

const fixture = JSON.parse(
	readFileSync(join(__dirname, "../../fixtures/subscription-limits/codex-response-headers.json"), "utf8"),
) as { headers: Record<string, string> };

const WEEKLY = { id: "codex:primary", label: "7d", windowMinutes: 10080, usedPercent: 99 };

describe("subscription limit windows over RPC (senpi#3370)", () => {
	it("records the windows a response reports, per provider and slot, and still runs the caller's hook", async () => {
		const store = new SubscriptionLimitStore();
		const seen: number[] = [];
		const options = withLimitCapture(
			{
				onResponse: (response: { status: number; headers: Record<string, string> }, _model: unknown) => {
					seen.push(response.status);
				},
			},
			"chatgpt-subscription",
			limitAccountOf({ slotName: "work" }),
			store,
		);

		await options.onResponse({ status: 200, headers: fixture.headers }, undefined);

		expect(seen).toEqual([200]);
		expect(store.snapshot()).toEqual([
			{
				provider: "chatgpt-subscription",
				account: "work",
				windows: [expect.objectContaining(WEEKLY)],
				reportedAt: expect.any(String),
			},
		]);
	});

	it("a real model-runtime request records what its response headers report", async () => {
		const harness = await createHarness({ fauxResponseHeaders: fixture.headers });
		try {
			harness.setResponses([fauxAssistantMessage("ok")]);
			const model = harness.faux.getModel();
			await getModelRuntime(harness.modelRegistry)
				.stream(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] })
				.result();

			expect(subscriptionLimits.snapshot()).toContainEqual(
				expect.objectContaining({
					provider: model.provider,
					account: "default",
					windows: [expect.objectContaining(WEEKLY)],
				}),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps an account absent until something reports, and merges later windows by id", () => {
		const store = new SubscriptionLimitStore();
		store.record("anthropic", "default", []);
		const empty = store.snapshot();
		store.record("anthropic", "default", [{ id: "claude:5h", label: "5h", usedPercent: 10 }]);
		store.record("anthropic", "default", [{ id: "claude:7d", label: "7d", usedPercent: 3 }]);
		store.record("anthropic", "default", [{ id: "claude:5h", label: "5h", usedPercent: 12 }]);

		expect(empty).toEqual([]);
		expect(store.snapshot()[0]?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
			["claude:5h", 12],
			["claude:7d", 3],
		]);
		expect([limitAccountOf(undefined), limitAccountOf({ apiKey: "k" })]).toEqual(["default", "env"]);
	});

	it("answers get_subscription_limits and broadcasts a subscription_limits record to every connection", async () => {
		const lines: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("c1", { writeRaw: (chunk) => lines.push(chunk), waitForBackpressure: async () => {} });
		const router = new SessionCommandRouter({ list: () => [] } as never, writer, { cwd: "/tmp" });
		try {
			subscriptionLimits.record("chatgpt-subscription", "default", [{ ...WEEKLY }]);
			const answer = await router.handle({ id: "q", type: "get_subscription_limits" });
			await writer.flush();

			expect(answer).toMatchObject({ success: true, command: "get_subscription_limits" });
			const accounts = (answer as { data: { accounts: unknown[] } }).data.accounts;
			expect(accounts).toContainEqual(
				expect.objectContaining({ provider: "chatgpt-subscription", account: "default", windows: [WEEKLY] }),
			);
			const records = lines
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			expect(records).toContainEqual(
				expect.objectContaining({
					type: "subscription_limits",
					provider: "chatgpt-subscription",
					windows: [WEEKLY],
				}),
			);
		} finally {
			await router.dispose();
		}
	});
});
