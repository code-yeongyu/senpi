import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, type Mock } from "vitest";
import {
	createBeforeAgentStartEvent,
	createBlockingContext,
	createCompactionHandlers,
} from "../helpers/blocking-compaction-harness.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

/**
 * Reproduction for the Discord-reported "Compaction did not apply" loop:
 * an idle/speculative warm summary pins `expectedRevision` at snapshot time
 * (speculative.ts createSpeculativeCompactionSnapshot). Any revision bump
 * while idle — e.g. an extension appending a hidden custom message via
 * `ctx.sendMessage` (agent-session.ts sendCustomMessage immediate-append
 * branch increments `_messageRevision`) — makes the warm result stale.
 *
 * `applyBlockingCompaction` (builtin/compaction/index.ts) then treats the
 * stale warm result as TERMINAL: it ends feedback (which the session surfaces
 * as "Compaction did not apply") and returns WITHOUT regenerating a fresh
 * summary, even though the whole point of the blocking route is that the
 * session is over the compaction threshold right now. "rejected" and
 * "unavailable" results fall through to fresh core-route generation; "stale"
 * does not. Context then keeps growing and the same failure repeats on every
 * later trigger, matching the field logs (warm_consumed -> speculative_stale
 * with no apply, tokens climbing).
 */
describe("Given a warm speculative summary made stale by an idle revision bump", () => {
	it("Then the blocking route still compacts instead of giving up with 'Compaction did not apply'", async () => {
		// Given: a session in the speculative warm-up band starts a warm job.
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 4_000 });
		registrations.push(harness.registration);
		let revision = 1;
		harness.ctx.getMessageRevision = () => revision;
		harness.registration.setResponses([
			fauxAssistantMessage("warm summary of the old context"),
			fauxAssistantMessage("fresh summary of the old context"),
		]);
		await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);

		// When: a hidden custom message bumps the message revision while idle,
		// then the next prompt crosses the compaction threshold.
		revision = 2;
		harness.setUsageTokens(6_000);
		await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);

		// Then: the blocking route must still apply a compaction (fresh
		// regeneration after discarding the stale warm result) ...
		const applyCompaction = harness.ctx.applyCompaction as unknown as Mock;
		expect(applyCompaction).toHaveBeenCalled();

		// ... and must not end feedback without an applied entry, which the
		// session reports to the user as "Compaction did not apply".
		const didNotApplyEndings = harness.endCompaction.mock.calls.filter(
			([options]) => (options as { errorMessage?: string }).errorMessage === undefined,
		);
		expect(didNotApplyEndings).toHaveLength(0);
	});
});
