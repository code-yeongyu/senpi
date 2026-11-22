import { expect, it } from "vitest";
import { createBoundLifecycleHarness } from "../lifecycle-test-harness.ts";

// senpi#3864: retirement returns producer custody without leaving abandoned engine-owned work.
for (const producerOwned of [false, true]) {
	it(`${producerOwned ? "returns an explicit ticket to its producer" : "cancels an implicit engine ticket"} when input aborts before admission`, async () => {
		const h = await createBoundLifecycleHarness({ persistSession: true });
		try {
			expect(h.session.workObligations).toBeDefined();
			const ticket = producerOwned
				? h.session.workObligations.open("result:review", "children").ticket()
				: undefined;
			const delivery = h.session.sendCustomMessage(
				{ customType: "senpi-task.completion", content: "Review passed.", display: false },
				{ triggerTurn: true, ...(ticket ? { ticket } : {}) },
			);
			// The send synchronously owns its payload, then awaits its header barrier.
			// Abort starts synchronously before that continuation can admit a turn.
			await h.session.abort();
			await delivery;
			expect(h.events.some((event) => event.type === "agent_start")).toBe(false);
			expect(h.session.workObligations.activeCount).toBe(producerOwned ? 1 : 0);
			const records = h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "work-custody");
			expect(records).toContainEqual(
				expect.objectContaining({
					data: expect.objectContaining(
						producerOwned ? { ticketId: ticket, state: "open", delivery: "retired" } : { state: "cancelled" },
					),
				}),
			);
			expect(h.agent.peekQueuedMessages({ all: true })).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});
}
