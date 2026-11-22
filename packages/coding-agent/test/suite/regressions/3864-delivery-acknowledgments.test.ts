import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createBoundLifecycleHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864: acknowledgments are final and retries do not duplicate queued model input.
it("closes a passive ticket immediately without claiming model consumption", async () => {
	const h = await createBoundLifecycleHarness();
	try {
		expect(h.session.workObligations).toBeDefined();
		const ticket = h.session.workObligations.open("display:review", "background").ticket();
		await h.session.sendCustomMessage(
			{ customType: "display-review", content: "Ready.", display: true },
			{ triggerTurn: false, ticket },
		);
		expect(h.session.workObligations.activeCount).toBe(0);
		const records = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "work-custody");
		expect(records).toContainEqual(
			expect.objectContaining({ data: expect.objectContaining({ state: "passive", ticketId: ticket }) }),
		);
		expect(records).not.toContainEqual(
			expect.objectContaining({ data: expect.objectContaining({ state: "consumed", ticketId: ticket }) }),
		);
	} finally {
		h.cleanup();
	}
});

it("acknowledges a held ticket once through the dependency's persisted notice", async () => {
	const h = await createBoundLifecycleHarness({
		persistSession: true,
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	try {
		expect(h.session.workObligations).toBeDefined();
		const ticket = h.session.workObligations.open("result:review", "children").ticket();
		const message = { customType: "senpi-task.completion", content: "Review passed.", display: false };
		await h.session.sendCustomMessage(message, { triggerTurn: true, ticket });
		await h.session.sendCustomMessage(message, { triggerTurn: true, ticket });
		expect(h.session.workObligations.activeCount).toBe(0);
		const entries = h.sessionManager.getEntries();
		const notices = entries.filter((entry) => entry.type === "custom" && entry.customType === "session-notice");
		expect(notices).toHaveLength(1);
		expect(entries.filter((entry) => entry.type === "custom" && entry.customType === "work-custody")).toContainEqual(
			expect.objectContaining({
				data: expect.objectContaining({
					state: "held",
					ticketId: ticket,
					noticeId: expect.any(String),
				}),
			}),
		);
		expect(h.session.lifecycle.state).toBe("held");
	} finally {
		h.cleanup();
	}
});

it("keeps a retained failed follow-up unique even while a steering message hides that queue", async () => {
	const h = await createBoundLifecycleHarness({ withConfiguredAuth: false });
	try {
		expect(h.session.workObligations).toBeDefined();
		const ticket = h.session.workObligations.open("result:review", "children").ticket();
		const message = { customType: "senpi-task.completion", content: "Review passed.", display: false };
		await expect(
			h.session.sendCustomMessage(message, { triggerTurn: true, deliverAs: "followUp", ticket }),
		).rejects.toThrow();
		h.agent.steer({ role: "user", content: "Earlier queued steer.", timestamp: Date.now() });
		await h.session.sendCustomMessage(message, { triggerTurn: true, deliverAs: "followUp", ticket });
		const matching = h.agent
			.peekQueuedMessages({ all: true })
			.filter((queued) => queued.role === "custom" && queued.customType === message.customType);
		expect(matching).toHaveLength(1);
		expect(h.session.workObligations.activeCount).toBe(1);
	} finally {
		h.cleanup();
	}
});

it("queues a next-turn ticket once and consumes it once in the admitted run", async () => {
	const h = await createBoundLifecycleHarness({ persistSession: true });
	try {
		expect(h.session.workObligations).toBeDefined();
		const ticket = h.session.workObligations.open("result:review", "children").ticket();
		const message = { customType: "senpi-task.completion", content: "Review passed.", display: false };
		await h.session.sendCustomMessage(message, { deliverAs: "nextTurn", ticket });
		await h.session.sendCustomMessage(message, { deliverAs: "nextTurn", ticket });
		expect(h.session.workObligations.activeCount).toBe(1);
		h.setResponses([fauxAssistantMessage("Review incorporated.")]);
		await runToAgentIdle(h, () => h.session.prompt("Incorporate it."));
		const entries = h.sessionManager.getEntries();
		expect(
			entries.filter((entry) => entry.type === "custom_message" && entry.customType === message.customType),
		).toHaveLength(1);
		expect(
			entries.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "work-custody" &&
					typeof entry.data === "object" &&
					entry.data !== null &&
					"state" in entry.data &&
					entry.data.state === "consumed",
			),
		).toHaveLength(1);
		expect(h.session.workObligations.activeCount).toBe(0);
	} finally {
		h.cleanup();
	}
});
