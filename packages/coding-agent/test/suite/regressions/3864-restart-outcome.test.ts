import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864: restoring a last turn does not reinterpret an error or an unexplained abort as success.
for (const stopReason of ["error", "aborted"] as const) {
	it(`preserves the ${stopReason === "error" ? "failure" : "stall"} and its identity across restart`, async () => {
		const a = await createBoundLifecycleHarness({ persistSession: true, settings: { retry: { enabled: false } } });
		let b: Harness | undefined;
		try {
			expect(a.session.lifecycle).toBeDefined();
			a.setResponses([fauxAssistantMessage("", { stopReason, errorMessage: "Synthetic terminal outcome." })]);
			await runToAgentIdle(a, () => a.session.prompt("Do the work."));
			const before = a.session.lifecycle;
			expect(before.state).toBe(stopReason === "error" ? "failed" : "waiting_human");
			const file = a.sessionManager.getSessionFile();
			if (!file) throw new Error("The fixture must have a durable transcript");
			a.session.dispose();
			b = await createBoundLifecycleHarness({ siblingOf: a, sessionManager: SessionManager.open(file) });
			expect(b.session.lifecycle).toMatchObject({
				state: before.state,
				epoch: before.epoch,
				restoring: false,
				persisted: true,
				...(stopReason === "error"
					? { completionId: before.completionId, failure: before.failure }
					: { waitingOn: { human: before.waitingOn?.human } }),
			});
			expect(b.events.some((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done")).toBe(
				false,
			);
		} finally {
			b?.cleanup();
			a.cleanup();
		}
	});
}
