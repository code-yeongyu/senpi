import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createBoundLifecycleHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864: preflight acceptance is not a gap in the next turn's custody.
it("cannot seal between a human prompt's started disposition and its native turn", async () => {
	const h = await createBoundLifecycleHarness({ persistSession: true });
	try {
		expect(h.session.workObligations).toBeDefined();
		const child = h.session.workObligations.open("task:review", "children");
		h.setResponses([fauxAssistantMessage("Waiting for review."), fauxAssistantMessage("Review incorporated.")]);
		await runToAgentIdle(h, () => h.session.prompt("Complete the work."));
		const epoch = h.session.lifecycle.epoch;
		let admitted = false;
		await runToAgentIdle(h, () =>
			h.session.prompt("Incorporate the review.", {
				promptDisposition: (disposition) => {
					if (disposition !== "started") return;
					admitted = true;
					child.close("cancelled");
					expect(
						h.events.some((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
					).toBe(false);
				},
			}),
		);
		expect(admitted).toBe(true);
		expect(h.session.lifecycle).toMatchObject({ state: "done", epoch, epochOrigin: "human", humanInputRevision: 2 });
		expect(
			h.events.filter((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
		).toHaveLength(1);
	} finally {
		h.cleanup();
	}
});
