import { expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createLifecycleHarness } from "../lifecycle-test-harness.ts";

// senpi#3864: runner terminal records outrank a stopped child's local producers.
it.each([
	["completed", "done"],
	["error", "failed"],
	["lost", "failed"],
	["cancelled", "cancelled"],
] as const)("uses the task's %s outcome while child background custody remains", async (terminal, state) => {
	// Given a child whose local background producer has not drained.
	const { h, publish } = await createLifecycleHarness({
		sessionManager: SessionManager.inMemory(undefined, {
			spawnedBy: { parentSessionId: "parent", rootSessionId: "root", taskId: "review" },
		}),
	});
	try {
		publish("wake_source_state", { source: "terminal-monitor", activeCount: 1 });
		expect(h.session.lifecycle.state).toBe("waiting_background");

		// When the runner writes the authoritative terminal result.
		h.session.reportChildLifecycle({
			taskId: "review",
			childSessionId: h.session.sessionId,
			runEpoch: 1,
			generation: 1,
			state,
			terminal,
		});

		// Then local producer cleanup cannot keep a terminal child alive.
		expect(h.session.lifecycle.state).toBe(state);
		expect(h.session.workObligations.activeCount).toBe(1);
	} finally {
		h.cleanup();
	}
});
