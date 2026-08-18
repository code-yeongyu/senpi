import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createBeforeAgentStartEvent,
	createBlockingContext,
	createCompactionHandlers,
} from "../helpers/blocking-compaction-harness.ts";

/**
 * The core `compact()` route wraps summarization in `retryAssistantCall` with
 * the session retry policy, so a transient provider failure costs a retry
 * instead of the whole compaction. The builtin compaction extension ran the
 * same kind of request with no retry: one transient 5xx ended it outright.
 *
 * Observed 2026-08-12: an upstream Cloudflare Worker answered summarization
 * with `500 Worker exceeded memory limit.` and the extension route reported
 * `willRetry:false` on attempt one, though the text already classified
 * transient.
 */

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function workerOomResponse() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 Worker exceeded memory limit." });
}

describe("blocking compaction shares the bounded summarization retry", () => {
	describe("Given a transient summarization failure followed by a success", () => {
		it("Then the extension route retries and applies the recovered compaction", async () => {
			// Given: the first attempt hits the upstream Worker OOM, the second works.
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			registrations.push(harness.registration);
			harness.registration.setResponses([
				workerOomResponse(),
				fauxAssistantMessage("Recovered summary of the discarded prefix."),
			]);

			// When: the blocking route runs for this prompt.
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.toBeUndefined();

			// Then: it paid for a retry and applied the recovered compaction.
			expect(harness.registration.state.callCount).toBe(2);
			expect(harness.ctx.applyCompaction).toHaveBeenCalled();
			expect(harness.endCompaction).not.toHaveBeenCalledWith(
				expect.objectContaining({ errorMessage: "Compaction failed: 500 Worker exceeded memory limit." }),
			);
		});
	});

	describe("Given every summarization attempt fails transiently", () => {
		it("Then the budget is exhausted before exactly one failure is reported", async () => {
			// Given: the Worker OOMs on every attempt within the retry budget.
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			registrations.push(harness.registration);
			harness.registration.setResponses([
				workerOomResponse(),
				workerOomResponse(),
				workerOomResponse(),
				workerOomResponse(),
			]);

			// When: the blocking route runs once.
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.toBeUndefined();

			// Then: every attempt in the budget was spent…
			expect(harness.registration.state.callCount).toBe(4);
			// …and exactly one terminal failure surfaced, upstream text intact.
			const failures = harness.endCompaction.mock.calls.filter(
				([options]) => options?.errorMessage === "Compaction failed: 500 Worker exceeded memory limit.",
			);
			expect(failures).toHaveLength(1);
		});
	});

	describe("Given a non-transient summarization failure", () => {
		it("Then the route does not spend a single retry", async () => {
			// Given: a deterministic provider rejection retrying cannot fix.
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			registrations.push(harness.registration);
			harness.registration.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "request blocked by provider policy" }),
			]);

			// When / Then: unchanged - it surfaces loudly on attempt one.
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).rejects.toThrow(
				/request blocked by provider policy/,
			);
			expect(harness.registration.state.callCount).toBe(1);
		});
	});
});
