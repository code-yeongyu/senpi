import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { LifecycleSessionBinding } from "../../../src/core/lifecycle-session-binding.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness as createUnboundHarness, type Harness } from "../harness.ts";
import { createBoundLifecycleHarness as createHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#4120 review: the lifecycle is no longer recomputed on read, so every fact that clears must raise its own
// edge. Compaction and branch summarization hold the session-work barrier and an abort controller past their
// end events; the state must follow them when they are released.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

async function settledSession(): Promise<Harness> {
	// keepRecentTokens: 1 so two short turns are enough to compact.
	const h = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("Reply 1."), fauxAssistantMessage("Reply 2.")]);
	await runToAgentIdle(h, () => h.session.prompt("Request 1"));
	await runToAgentIdle(h, () => h.session.prompt("Request 2"));
	expect(h.session.lifecycle.state).toBe("done");
	return h;
}

it("returns to its prior state after a manual compaction with no run", async () => {
	// Given a settled session.
	const h = await settledSession();
	h.setResponses([
		fauxAssistantMessage("Summary of the conversation."),
		fauxAssistantMessage("Summary of the turn prefix."),
	]);

	// When the person compacts it manually.
	await h.session.compact();

	// Then the state a client reads is the settled one again, without anything else happening.
	expect(h.session.lifecycle.state).toBe("done");
});

it("returns to its prior state after a manual compaction whose summary fails", async () => {
	// Given a settled session whose summarization request fails.
	const h = await settledSession();
	h.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" }),
	]);

	// When the person compacts it manually and the compaction fails.
	await h.session.compact().catch(() => undefined);

	// Then the state is the settled one again.
	expect(h.session.lifecycle.state).toBe("done");
});

it("writes no lifecycle record during a tree navigation with a branch summary and reads settled after it", async () => {
	// Given a settled session with an earlier branch point.
	const h = await settledSession();
	const target = h.session.sessionManager.getEntries().find((entry) => entry.type === "message");
	if (!target) throw new Error("expected a message entry to navigate to");
	let releaseSummary!: () => void;
	const summaryHeld = new Promise<void>((resolve) => {
		releaseSummary = resolve;
	});
	let summaryStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		summaryStarted = resolve;
	});
	h.setResponses([
		async () => {
			summaryStarted();
			await summaryHeld;
			return fauxAssistantMessage("Branch summary.");
		},
	]);

	const append = vi.spyOn(h.session.sessionManager, "appendCustomEntry");

	// When the person navigates the tree with a summary, and the summary is written and ends.
	const navigation = h.session.navigateTree(target.id, { summarize: true });
	await started;
	releaseSummary();
	await navigation;

	// Then no lifecycle record was written into the tree while it navigated, and the session reads settled.
	expect(append.mock.calls.filter(([type]) => type === "session-lifecycle")).toEqual([]);
	expect(h.session.lifecycle.state).toBe("done");
});

it("writes no lifecycle record after dispose when an in-flight compaction unwinds", async () => {
	// Given a settled session whose manual compaction is still writing its summary.
	const h = await settledSession();
	let releaseSummary!: () => void;
	const summaryHeld = new Promise<void>((resolve) => {
		releaseSummary = resolve;
	});
	let summaryStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		summaryStarted = resolve;
	});
	h.setResponses([
		async () => {
			summaryStarted();
			await summaryHeld;
			return fauxAssistantMessage("Summary of the conversation.");
		},
		fauxAssistantMessage("Summary of the turn prefix."),
	]);
	const compaction = h.session.compact().catch(() => undefined);
	await started;
	const append = vi.spyOn(h.session.sessionManager, "appendCustomEntry");

	// When the session is disposed and the compaction then unwinds.
	h.session.dispose();
	releaseSummary();
	await compaction;

	// Then nothing appended a lifecycle record to the released session file.
	expect(append.mock.calls.filter(([type]) => type === "session-lifecycle")).toEqual([]);
});

function spyWrites(manager: SessionManager) {
	return [
		vi.spyOn(manager, "appendCustomEntry"),
		vi.spyOn(manager, "appendMessage"),
		vi.spyOn(manager, "appendCustomMessageEntry"),
	];
}

function writeCount(spies: ReturnType<typeof spyWrites>): number {
	return spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

function bindingOf(h: Harness): LifecycleSessionBinding {
	return (h.session as unknown as { _lifecycleBinding: LifecycleSessionBinding })._lifecycleBinding;
}

it("writes nothing after dispose through any lifecycle write path, including a restore that finishes after it", async () => {
	// Given a live session whose run is in flight, and a persisted session with a queued delivery to restore.
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	const ticket = h.session.workObligations.open("result:queued", "children").ticket();
	h.session.workObligations.queue(ticket, {
		message: { customType: "omo-senpi:wake", content: "Task finished", display: false },
		deliverAs: "followUp",
	});
	h.session.workObligations.endDelivery(ticket);
	let releaseReply!: () => void;
	const replyHeld = new Promise<void>((resolve) => {
		releaseReply = resolve;
	});
	let replyStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		replyStarted = resolve;
	});
	h.setResponses([
		async () => {
			replyStarted();
			await replyHeld;
			return fauxAssistantMessage("Reply.");
		},
	]);
	void h.session.prompt("Request").catch(() => undefined);
	await started;
	const file = h.sessionManager.getSessionFile();
	if (!file) throw new Error("A persisted session file is required");
	// Not bound yet: its restore starts below, and dispose() lands while it reads the goal facts.
	const reopened = await createUnboundHarness({ siblingOf: h, sessionManager: SessionManager.open(file) });
	harnesses.push(reopened);

	// When both sessions are disposed and every write path then runs: the deferred-turn idle, the agent_end turn end,
	// a human input, a run start, the queued delivery being consumed, a child report, a new obligation, and a restore
	// that was already under way.
	const binding = bindingOf(h);
	const restoring = bindingOf(reopened).restore();
	h.session.dispose();
	reopened.session.dispose();
	const liveWrites = spyWrites(h.session.sessionManager);
	const restoreWrites = spyWrites(reopened.session.sessionManager);
	binding.controller.idle();
	const turnEnd = { type: "agent_end" as const, messages: [] };
	await binding.turnEnded(turnEnd, turnEnd);
	binding.controller.humanInput(new Date().toISOString());
	binding.controller.startRun("automatic");
	binding.consume({
		role: "custom",
		customType: "omo-senpi:wake",
		content: "Task finished",
		display: false,
		details: { ticketId: ticket },
		timestamp: Date.now(),
	});
	h.session.reportChildLifecycle({
		taskId: "task-1",
		childSessionId: "child-1",
		runEpoch: 1,
		generation: 1,
		state: "running",
	});
	h.session.workObligations.open("result:late", "children");
	await restoring;
	releaseReply();

	// Then neither released session file received a single append.
	expect(writeCount(liveWrites)).toBe(0);
	expect(writeCount(restoreWrites)).toBe(0);
});
