import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, type Mock } from "vitest";
import { createWarmAnchorSnapshot, isWarmSummaryAnchorValid } from "../../src/core/compaction/warm-anchor.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	createBeforeAgentStartEvent,
	createBlockingContext,
	createCompactionHandlers,
} from "../helpers/blocking-compaction-harness.ts";

function userEntry(text: string, timestamp: number) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp };
}

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

/**
 * The idle warm-up exists so the summarization request happens while the user is
 * NOT waiting. Its warm result was pinned to `expectedRevision`, a counter that
 * agent-session bumps on every appended message. During a cache-warm idle wait
 * the session keeps appending (wait notices, monitor state, and finally the
 * user's own next prompt), so the warm summary was guaranteed stale exactly when
 * the blocking route needed it, and the user paid a full fresh summarization.
 *
 * What actually invalidates a warm summary is a rewrite of the history it
 * summarized - not growth after the cut. `CompactionPreparation.firstKeptEntryId`
 * anchors that cut: entries appended while idle land after the anchor, inside the
 * kept suffix, and leave the summarized prefix intact.
 */
describe("Given a warm speculative summary and idle-time message appends", () => {
	it("Then the warm summary is applied because the summarized prefix is untouched", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 4_000 });
		registrations.push(harness.registration);

		// Given: the session is in the warm-up band, so a warm job is started.
		let revision = 1;
		harness.ctx.getMessageRevision = () => revision;
		harness.registration.setResponses([
			fauxAssistantMessage("warm summary of the old context"),
			fauxAssistantMessage("fresh summary the user should never have to wait for"),
		]);
		await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
		await handlers.waitForSpeculativeJob();

		// When: idle-time appends bump the revision without rewriting the
		// summarized prefix, and the next prompt crosses the threshold.
		revision = 7;
		harness.setUsageTokens(6_000);
		await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);

		// Then: the warm result is consumed instead of being thrown away, so only
		// the warm-up request was ever billed for a summary.
		const applyCompaction = harness.ctx.applyCompaction as unknown as Mock;
		expect(applyCompaction).toHaveBeenCalledTimes(1);
		expect(harness.registration.state.callCount).toBe(1);
	});

	it("Then a warm summary whose summarized prefix was rewritten is rejected and regenerated", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 4_000 });
		registrations.push(harness.registration);

		let revision = 1;
		harness.ctx.getMessageRevision = () => revision;
		harness.registration.setResponses([
			fauxAssistantMessage("warm summary of the old context"),
			fauxAssistantMessage("fresh summary after the prefix was rewritten"),
		]);
		await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
		await handlers.waitForSpeculativeJob();

		// When: a compaction boundary lands, the warm summary now describes
		// history that no longer exists in the branch it would be applied to.
		harness.sessionManager.appendCompaction(
			"a different summary already committed by another route",
			harness.sessionManager.getBranch()[0].id,
			1_000,
		);
		// A compaction record as the branch tip makes prepareCompaction bail, so the
		// session must carry a message past the new boundary to be compactable again.
		harness.sessionManager.appendMessage(userEntry("work after the new boundary", 9));
		revision = 7;
		harness.setUsageTokens(6_000);
		await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);

		// Then: the stale warm result must never be applied against the rewritten
		// history; the route regenerates instead.
		const applyCompaction = harness.ctx.applyCompaction as unknown as Mock;
		const appliedWarmSummary = applyCompaction.mock.calls.some(([precomputed]) =>
			JSON.stringify(precomputed).includes("warm summary of the old context"),
		);
		expect(appliedWarmSummary).toBe(false);

		// The route must not merely decline the stale result; it must regenerate,
		// otherwise the session stays over the threshold with nothing applied.
		const appliedFreshSummary = applyCompaction.mock.calls.some(([precomputed]) =>
			JSON.stringify(precomputed).includes("fresh summary after the prefix was rewritten"),
		);
		expect(appliedFreshSummary).toBe(true);
	});
});

describe("Given a session that has already been compacted once", () => {
	it("Then a warm summary whose new anchor precedes the existing compaction record stays valid", () => {
		// Given: compaction records are appended AFTER the entries they summarize, so an
		// existing boundary sits later in the branch than the next cut point.
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userEntry("e0", 1));
		sessionManager.appendMessage(userEntry("e1", 2));
		sessionManager.appendMessage(userEntry("e2", 3));
		sessionManager.appendMessage(userEntry("e3", 4));
		const beforeCompaction = sessionManager.getBranch();
		sessionManager.appendCompaction("summary from the first compaction", beforeCompaction[1].id, 1_000);
		sessionManager.appendMessage(userEntry("kept after the boundary", 5));

		const branch = sessionManager.getBranch();
		const anchorId = branch[3].id;
		const compactionIndex = branch.findIndex((entry) => entry.type === "compaction");
		expect(compactionIndex).toBeGreaterThan(3);
		const warmAnchor = createWarmAnchorSnapshot(anchorId, branch);

		// When: idle-time messages append after the cut, rewriting nothing.
		sessionManager.appendMessage(userEntry("idle-time note", 6));

		// Then: the warm summary must remain applicable.
		expect(warmAnchor).toBeDefined();
		expect(warmAnchor && isWarmSummaryAnchorValid(warmAnchor, sessionManager.getBranch())).toBe(true);
	});

	it("Then a newly landed compaction boundary still invalidates the warm summary", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userEntry("e0", 1));
		sessionManager.appendMessage(userEntry("e1", 2));
		sessionManager.appendMessage(userEntry("e2", 3));
		const snapshotBranch = sessionManager.getBranch();
		const anchorId = snapshotBranch[2].id;

		const warmAnchor = createWarmAnchorSnapshot(anchorId, snapshotBranch);
		sessionManager.appendCompaction("a boundary that landed after the snapshot", snapshotBranch[1].id, 1_000);

		expect(warmAnchor).toBeDefined();
		expect(warmAnchor && isWarmSummaryAnchorValid(warmAnchor, sessionManager.getBranch())).toBe(false);
	});
});
