import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { resumeFixture, settlesWithin } from "./issue-3811-resume-support.ts";

// senpi#4420: settlement must not strand a ticket re-admitted after Esc during header persistence.
it("retains re-admitted delivery custody through settled handlers and closes it at agent_idle", async () => {
	// Given an Esc during header persistence and a handler that holds the subsequent settle.
	const fixture = await resumeFixture();
	const session = fixture.h.session;
	const held = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const idle = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "agent_idle") idle.resolve();
	});
	fixture.api().on("agent_settled", async () => {
		entered.resolve();
		await held.promise;
	});
	fixture.h.setResponses([fauxAssistantMessage("delivered")]);
	const ticket = fixture.api().lifecycle.obligations.open("result:abort-window", "children").ticket();
	const manager = fixture.h.sessionManager;
	const persist = manager.persistHeaderNow.bind(manager);
	const persistSpy = vi.spyOn(manager, "persistHeaderNow").mockImplementationOnce(async () => {
		await session.abort();
		return persist();
	});
	try {
		// When the re-admitted batch runs, the early settle is observable while its handler remains held.
		const receipts = await fixture.api().sendMessage(
			{ customType: "omo-senpi:wake", content: "batch result", display: false },
			{
				triggerTurn: true,
				deliverAs: "followUp",
				ticket,
				items: [{ itemId: "result", producer: "task", content: "batch result" }],
			},
		);
		await settlesWithin(entered.promise, "the settled handler");

		// Then the batch is written once, but custody remains consumed until the handler releases agent_idle.
		expect(receipts?.map((receipt) => receipt.disposition)).toEqual(["message_persisted"]);
		expect(fixture.h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(fixture.h.eventsOfType("agent_idle")).toHaveLength(0);
		expect(session.workObligations.active.find((record) => record.ticketId === ticket)?.state).toBe("consumed");
		held.resolve();
		await settlesWithin(idle.promise, "agent_idle");
		expect(fixture.h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(session.workObligations.active.some((record) => record.ticketId === ticket)).toBe(false);
		expect(session.lifecycle.state).toBe("done");
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(
			session.messages.filter((message) => message.role === "custom" && message.customType === "omo-senpi:wake"),
		).toHaveLength(1);
	} finally {
		held.resolve();
		unsubscribe();
		persistSpy.mockRestore();
		await session.waitForSettledSessionWork();
		await session.abort();
		fixture.h.cleanup();
	}
});
