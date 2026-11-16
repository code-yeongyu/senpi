/**
 * senpi#6727: when every pooled Claude account is out, the pool refuses locally and names its soonest retry. The
 * session's retry must wait for that moment, or stop at once when it is too far off, instead of spending its whole
 * budget (`Attempt 5/5`) on refusals that cannot change before then.
 */
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AllAccountsBlockedError } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { createHarness, type Harness } from "../harness.ts";

const NOW = Date.parse("2026-11-15T10:20:00Z");
const FIVE_HOURS = 5 * 60 * 60 * 1_000;

const model: Model<Api> = {
	id: "claude-opus-test",
	name: "Claude Opus test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

async function poolRefusal(bravoUntil: number): Promise<AssistantMessage> {
	const refusal = new AllAccountsBlockedError(
		bravoUntil,
		undefined,
		undefined,
		undefined,
		[
			{ name: "alpha", reason: "rate_limit", until: NOW + FIVE_HOURS },
			{ name: "bravo", reason: "rate_limit", until: bravoUntil },
		],
		bravoUntil,
	);
	overrideSdkBoundary({
		query: () => ({
			async *[Symbol.asyncIterator]() {
				yield* [];
				throw refusal;
			},
			async interrupt() {},
			close() {},
		}),
	});
	const message = await streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() }).result();
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: message.errorMessage }),
		providerDiagnostic: message.providerDiagnostic,
	};
}

describe("a locally refused account pool paces the session retry by its soonest retry (senpi#6727)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		resetSdkBoundary();
		vi.useRealTimers();
	});

	async function session(maxRetries: number): Promise<Harness> {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries, baseDelayMs: 1 }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		return harness;
	}

	it("waits for the account that returns soonest instead of retrying at the backoff floor", async () => {
		const harness = await session(5);
		harness.setResponses([await poolRefusal(NOW + 40), fauxAssistantMessage("served by bravo")]);

		await harness.session.prompt("hello");

		// The first retry is paced by the pool's 40 ms soonest retry (probe at half of it), not the 1 ms backoff floor.
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([20]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("stops at once when no account returns before the probe-back window, naming the wait", async () => {
		const harness = await session(5);
		const twoHours = 2 * 60 * 60 * 1_000;
		harness.setResponses([await poolRefusal(NOW + twoHours)]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		const ends = harness.eventsOfType("auto_retry_end");
		expect(ends).toMatchObject([{ success: false, attempt: 0 }]);
		expect(ends[0]?.finalError).toContain(`${twoHours / 1_000}s`);
		expect(ends[0]?.finalError).toContain("bravo: rate_limit until 2026-11-15T12:20:00.000Z");
	});
});
