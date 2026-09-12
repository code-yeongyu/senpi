import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SUMMARIZATION_ATTEMPT_RETRIES } from "../../src/core/extensions/builtin/compaction/summarization-retry.ts";
import {
	connectionErrorResponse,
	createBeforeAgentStartEvent,
	createBlockingContext,
	createCompactionHandlers,
} from "../helpers/blocking-compaction-harness.ts";

/** One summarization now costs its initial attempt plus the shared retry budget. */
const SUMMARIZATION_ATTEMPTS = 1 + MAX_SUMMARIZATION_ATTEMPT_RETRIES;

const registrations: Array<{ unregister: () => void }> = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

async function settleRetryBackoff<T>(operation: T | PromiseLike<T>): Promise<T> {
	await vi.runAllTimersAsync();
	return await operation;
}

describe("blocking compaction network-failure degradation", () => {
	describe("Given the provider connection drops during emergency blocking compaction", () => {
		it("Then before_agent_start degrades cleanly instead of erroring the turn", async () => {
			// Given: usage at the hard limit forces blocking compaction, and the
			// summarization request fails with a transient connection error.
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			registrations.push(harness.registration);
			harness.registration.setResponses(
				Array.from({ length: SUMMARIZATION_ATTEMPTS }, () => connectionErrorResponse()),
			);

			// When / Then: the handler resolves (no extension-error stack surface)…
			const compaction = beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
			await expect(settleRetryBackoff(compaction)).resolves.toBeUndefined();

			// …and the single clean surface is compaction_end's errorMessage.
			expect(harness.endCompaction).toHaveBeenCalledWith(
				expect.objectContaining({ errorMessage: "Compaction failed: Connection error." }),
			);
		});
	});

	describe("Given repeated transient blocking-compaction failures", () => {
		it("Then the circuit breaker skips further proactive attempts during cooldown", async () => {
			// Given: usage above the proactive threshold (45% of 10k) but below the
			// hard limit, so the proactive blocking route is taken each prompt.
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 6_000 });
			registrations.push(harness.registration);
			harness.registration.setResponses(
				Array.from({ length: 3 * SUMMARIZATION_ATTEMPTS }, () => connectionErrorResponse()),
			);

			// When: three consecutive prompts fail on connection errors.
			for (let attempt = 0; attempt < 3; attempt++) {
				const compaction = beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
				await expect(settleRetryBackoff(compaction)).resolves.toBeUndefined();
			}
			const callsAfterTrip = harness.registration.state.callCount;
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.toBeUndefined();

			// Then: the tripped breaker stops the fourth prompt from paying for
			// another doomed summarization request.
			expect(callsAfterTrip).toBe(3 * SUMMARIZATION_ATTEMPTS);
			expect(harness.registration.state.callCount).toBe(callsAfterTrip);
		});
	});

	describe("Given a non-transient summarization failure", () => {
		it("Then the failure still surfaces loudly as an extension error", async () => {
			// Given: a deterministic provider rejection that retrying cannot fix.
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			registrations.push(harness.registration);
			harness.registration.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "request blocked by provider policy",
				}),
			]);

			// When / Then: unchanged behavior — real bugs and policy rejections
			// keep propagating so they stay visible.
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).rejects.toThrow(
				"request blocked by provider policy",
			);
		});
	});

	describe("Given summarization credentials are unavailable", () => {
		it("Then blocking compaction degrades silently as before", async () => {
			// Given
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950, withAuth: false });
			registrations.push(harness.registration);
			harness.registration.setResponses([fauxAssistantMessage("never reached")]);

			// When / Then: SummaryGenerationError keeps its degrade-to-unavailable
			// contract, and the concrete reason is surfaced on the compaction feedback
			// (issue #765) instead of the bare generic message.
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.toBeUndefined();
			const messages = harness.endCompaction.mock.calls.map((call) => call[0]?.errorMessage);
			expect(messages).toContain("Compaction did not apply: unavailable");
		});
	});
});
