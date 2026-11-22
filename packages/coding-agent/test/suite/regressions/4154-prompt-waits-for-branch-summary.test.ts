import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionWorkBarrier } from "../../../src/core/session-work-barrier.ts";
import { createHarness, type Harness } from "../harness.ts";
import { runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#4154: a tree navigation's branch summary is a model call. A prompt (a scheduled tick, a /loop tick, an RPC
// prompt) that arrives while it runs must wait for the navigation, not start a run on the leaf being moved.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

it("starts a prompt's run only after a tree navigation's branch summary has been written", async () => {
	// Given a settled session with an earlier branch point.
	const h = await createHarness();
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("Reply 1."), fauxAssistantMessage("Reply 2.")]);
	await runToAgentIdle(h, () => h.session.prompt("Request 1"));
	await runToAgentIdle(h, () => h.session.prompt("Request 2"));
	const target = h.session.sessionManager.getEntries().find((entry) => entry.type === "message");
	if (!target) throw new Error("expected a message entry to navigate to");

	// The summary ends at the first of two signals: the prompt's run started (the race), or the prompt is parked
	// behind the navigation's session work (the fix). Either way the order of events below decides the test.
	const order: string[] = [];
	const promptRunStarted = Promise.withResolvers<void>();
	const promptParked = Promise.withResolvers<void>();
	const unsubscribe = h.session.subscribe((event) => {
		if (event.type === "agent_start") {
			order.push("prompt-run");
			promptRunStarted.resolve();
		}
	});
	const barrier = (h.session as unknown as { _sessionWorkBarrier: SessionWorkBarrier })._sessionWorkBarrier;
	const waitForSettled = barrier.waitForSettled.bind(barrier);
	vi.spyOn(barrier, "waitForSettled").mockImplementation((...args) => {
		if (barrier.hasActiveWork) promptParked.resolve();
		return waitForSettled(...args);
	});
	const summaryStarted = Promise.withResolvers<void>();
	h.setResponses([
		async () => {
			order.push("summary-start");
			summaryStarted.resolve();
			await Promise.race([promptRunStarted.promise, promptParked.promise]);
			order.push("summary-end");
			return fauxAssistantMessage("Branch summary.");
		},
		fauxAssistantMessage("Prompt reply."),
	]);

	// When the person navigates with a summary and a prompt arrives while the summary is written.
	const navigation = h.session.navigateTree(target.id, { summarize: true });
	await summaryStarted.promise;
	const prompted = runToAgentIdle(h, () => h.session.prompt("Scheduled tick"));
	const result = await navigation;
	await prompted;
	unsubscribe();

	// Then the prompt's run started only after the summary ended, and the navigation landed with its summary.
	expect(order).toEqual(["summary-start", "summary-end", "prompt-run"]);
	expect(result.cancelled).toBe(false);
	expect(result.summaryEntry?.type).toBe("branch_summary");
});
