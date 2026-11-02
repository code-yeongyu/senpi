import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createLifecycleHarness, nextSessionEvent, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864: turn-end facts must not resurrect a source after its live registry drains.
it("seals work after the final live source drains following a turn", async () => {
	// Given a turn whose end facts include an active background monitor.
	const { h, publish } = await createLifecycleHarness();
	try {
		expect(h.session.lifecycle).toBeDefined();
		publish("wake_source_state", { source: "terminal-monitor", activeCount: 1 });
		h.setResponses([fauxAssistantMessage("Waiting for the monitor.")]);
		await runToAgentIdle(h, () => h.session.prompt("Watch for the result."));
		expect(h.session.lifecycle.state).toBe("waiting_background");
		const done = nextSessionEvent(
			h,
			(event) => event.type === "session_lifecycle" && event.lifecycle.state === "done",
		);

		// When the same live registry closes the last source.
		publish("wake_source_state", { source: "terminal-monitor", activeCount: 0 });
		await done;

		// Then a stale turn-end expectation cannot keep the completed work alive.
		expect(h.session.lifecycle).toMatchObject({
			state: "done",
			waitingOn: { children: 0, background: [], human: [] },
		});
	} finally {
		h.cleanup();
	}
});
