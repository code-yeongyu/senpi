import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendMessageItem, SendMessageReceipt } from "../../../src/core/extensions/types.ts";
import { QueuedDeliveryCleared } from "../../../src/core/itemized-send.ts";
import { DeliveryTicketRefused } from "../../../src/core/work-obligations.ts";
import { type ResumeFixture, resumeFixture, settle, settlesWithin } from "./issue-3811-resume-support.ts";

const WAKE = "omo-senpi:wake";
const items: readonly SendMessageItem[] = [
	{ itemId: "a", producer: "task", content: "Task A finished" },
	{ itemId: "b", producer: "task", content: "Task B finished" },
];

async function textFixture(): Promise<ResumeFixture> {
	const fixture = await resumeFixture();
	fixture.h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	return fixture;
}

function sendWithTicket(fixture: ResumeFixture, ticket: string, batch: readonly SendMessageItem[] = items) {
	return fixture
		.api()
		.sendMessage(
			{ customType: WAKE, content: batch.map((item) => item.content).join("\n\n"), display: false },
			{ triggerTurn: true, deliverAs: "followUp", items: batch, ticket },
		);
}

/** How many written-carrier entries the session still keeps for in-flight re-sends. */
function writtenEntries(fixture: ResumeFixture): number {
	return (fixture.h.session as unknown as { _writtenTicketEntries: Map<string, string> })._writtenTicketEntries.size;
}

function openTicket(fixture: ResumeFixture, key: string): string {
	return fixture.api().lifecycle.obligations.open(key, "children").ticket();
}

function ticketOpen(fixture: ResumeFixture, ticket: string): boolean {
	return fixture.h.session.workObligations.active.some((record) => record.ticketId === ticket);
}

function persistedNotices(fixture: ResumeFixture): number {
	return fixture.h
		.eventsOfType("session_notice")
		.filter((event) => event.disposition === "notice_persisted")
		.reduce((sum, event) => sum + event.noticeIds.length, 0);
}

/** Custody settles at agent_idle, after the run's notification handlers; subscribe before starting it. */
function nextRunIdle(fixture: ResumeFixture): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = fixture.h.session.subscribe((event) => {
			if (event.type !== "agent_idle") return;
			unsubscribe();
			resolve();
		});
	});
}

/** Resolves once the ticket's delivery released it: the queued message is in custody, no longer being delivered. */
function deliveryEnded(fixture: ResumeFixture, ticket: string): Promise<void> {
	const obligations = fixture.h.session.workObligations;
	const endDelivery = obligations.endDelivery.bind(obligations);
	const ended = Promise.withResolvers<void>();
	obligations.endDelivery = (ticketId) => {
		endDelivery(ticketId);
		if (ticketId === ticket) ended.resolve();
	};
	return ended.promise;
}

// senpi#3864 x senpi#3811: an itemized send carrying a delivery ticket settles that ticket exactly once.
describe("itemized sendMessage with a delivery ticket", () => {
	const fixtures: ResumeFixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			await fixture.h.session.abort();
			fixture.h.cleanup();
		}
	});

	it("hands the ticket to the held notices, so the session is done once the resume delivers them", async () => {
		// Given a stopped session and a producer ticket for the batch
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();
		const ticket = openTicket(fixture, "result:batch");

		// When the batch is sent with that ticket while the Stop holds it
		const receipts = await sendWithTicket(fixture, ticket);

		// Then every item is a held notice and the ticket is no longer open work
		expect(receipts?.map((receipt) => receipt.disposition)).toEqual(["notice_persisted", "notice_persisted"]);
		expect(ticketOpen(fixture, ticket)).toBe(false);

		// When the person resumes and the notices are delivered
		await fixture.h.session.resumeSession();
		await settle(fixture);

		// Then nothing is owed any more
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(fixture.h.session.workObligations.activeCount).toBe(0);
		expect(fixture.h.session.lifecycle.state).toBe("done");
	});

	it("keeps the ticket on a batch a Stop dropped during admission, and settles it once", async () => {
		// Given a batch whose admission is overtaken by a Stop while its header is written
		const fixture = await textFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:batch");
		const manager = fixture.h.sessionManager;
		const persist = manager.persistHeaderNow.bind(manager);
		let stopped = false;
		manager.persistHeaderNow = async () => {
			if (!stopped) {
				stopped = true;
				await fixture.h.session.stop();
			}
			return persist();
		};

		// When the batch is sent with that ticket
		const receipts = await sendWithTicket(fixture, ticket);

		// Then the dropped batch is decided again under the Stop: held, not rejected, and its ticket is not left open
		expect(stopped).toBe(true);
		expect(receipts?.map((receipt) => receipt.disposition)).toEqual(["notice_persisted", "notice_persisted"]);
		expect(ticketOpen(fixture, ticket)).toBe(false);

		// When the person resumes
		await fixture.h.session.resumeSession();
		await settle(fixture);

		// Then the session is done with nothing owed
		expect(fixture.h.session.workObligations.activeCount).toBe(0);
		expect(fixture.h.session.lifecycle.state).toBe("done");
	});

	it("writes a held batch's notices once when the same ticketed batch is sent again while stopped", async () => {
		// Given a stopped session whose ticketed batch is already held
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();
		const ticket = openTicket(fixture, "result:batch");
		await sendWithTicket(fixture, ticket);
		expect(persistedNotices(fixture)).toBe(2);

		// When the producer retries the same batch with the same ticket
		const retry = sendWithTicket(fixture, ticket);

		// Then the retry is refused before anything is written, and resume delivers each item once
		await expect(retry).rejects.toBeInstanceOf(DeliveryTicketRefused);
		expect(persistedNotices(fixture)).toBe(2);
		await fixture.h.session.resumeSession();
		await settle(fixture);
		const delivered = JSON.stringify(fixture.h.faux.getCallLog().at(-1)?.context.messages);
		expect(delivered.split("Task A finished").length - 1).toBe(1);
	});

	it("writes nothing and rejects when a held batch carries an unknown ticket", async () => {
		// Given a stopped session
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();

		// When a batch is sent with a ticket custody never issued
		const sent = sendWithTicket(fixture, "never-issued");

		// Then the promise rejects and no item is kept
		await expect(sent).rejects.toBeInstanceOf(DeliveryTicketRefused);
		expect(persistedNotices(fixture)).toBe(0);
	});

	it("delivers a batch a plain abort (Esc) dropped during admission and settles its ticket", async () => {
		// Given a batch whose admission is overtaken by a user abort while its header is written
		const fixture = await textFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:batch");
		const manager = fixture.h.sessionManager;
		const persist = manager.persistHeaderNow.bind(manager);
		let aborted = false;
		manager.persistHeaderNow = async () => {
			if (!aborted) {
				aborted = true;
				await fixture.h.session.abort();
			}
			return persist();
		};

		// When the batch is sent with that ticket, and the turn reaches its custody settlement boundary
		const runEnded = nextRunIdle(fixture);
		const receipts = await sendWithTicket(fixture, ticket);
		await settlesWithin(runEnded, "the re-admitted batch's turn");
		await settle(fixture);

		// Then nothing holds it: it is decided again, delivered, and its ticket is settled
		expect(aborted).toBe(true);
		expect(receipts?.map((receipt) => receipt.disposition)).toEqual(["message_persisted", "message_persisted"]);
		expect(ticketOpen(fixture, ticket)).toBe(false);
		expect(fixture.h.session.lifecycle.state).toBe("done");
	});

	it("settles a re-send whose ticket's message is still queued with the queued message's receipts", async () => {
		// Given a running turn and a ticketed batch queued as a follow-up behind it
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:batch");
		const toolStarted = fixture.toolStarted();
		const running = fixture.h.session.prompt("start");
		await toolStarted;
		const ended = deliveryEnded(fixture, ticket);
		const first = sendWithTicket(fixture, ticket);
		await ended;

		// When the producer re-sends the same batch while that message is still queued
		const again = sendWithTicket(fixture, ticket);
		fixture.releaseTool();
		await running;
		await settle(fixture);

		// Then both sends settle with the one entry that carried the queued message, and the ticket is settled
		const [firstReceipts, againReceipts] = await settlesWithin(Promise.all([first, again]), "itemized receipts");
		expect(againReceipts?.map((receipt) => receipt.disposition)).toEqual(["message_persisted", "message_persisted"]);
		expect(againReceipts?.map((receipt) => receipt.entryId)).toEqual(
			firstReceipts?.map((receipt) => receipt.entryId),
		);
		expect(ticketOpen(fixture, ticket)).toBe(false);
	});

	it("refuses a re-send of a queued ticket that carries different items, and keeps the queued message as sent", async () => {
		// Given a running turn and a ticketed batch queued as a follow-up behind it (senpi#4106)
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:batch");
		const toolStarted = fixture.toolStarted();
		const running = fixture.h.session.prompt("start");
		await toolStarted;
		const ended = deliveryEnded(fixture, ticket);
		const first = sendWithTicket(fixture, ticket);
		await ended;

		// When the producer re-sends the ticket with an item the queued message does not carry
		const other: readonly SendMessageItem[] = [{ itemId: "c", producer: "task", content: "Task C finished" }];
		const again = Promise.resolve(sendWithTicket(fixture, ticket, other)).then(
			() => undefined,
			(error: unknown) => error,
		);
		fixture.releaseTool();
		await running;
		await settle(fixture);

		// Then no receipt claims item c was written, and the written entry is the first send's batch
		const [firstReceipts, refused] = await settlesWithin(Promise.all([first, again]), "itemized receipts");
		expect(refused).toBeInstanceOf(DeliveryTicketRefused);
		expect(firstReceipts?.map((receipt: SendMessageReceipt) => receipt.itemId)).toEqual(["a", "b"]);
		const written = fixture.h.session.messages.flatMap((message) =>
			message.role === "custom" && message.customType === WAKE ? [message.content] : [],
		);
		expect(written).toEqual(["Task A finished\n\nTask B finished"]);
		expect(ticketOpen(fixture, ticket)).toBe(false);
	});

	it("settles the queued batch and a joined re-send when clearQueue removes the queued message", async () => {
		// Given a running turn, a ticketed batch queued behind it, and a re-send of that batch joined to it (senpi#4106)
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:batch");
		const toolStarted = fixture.toolStarted();
		const running = fixture.h.session.prompt("start");
		await toolStarted;
		const ended = deliveryEnded(fixture, ticket);
		const outcome = (sent: ReturnType<typeof sendWithTicket>) =>
			Promise.resolve(sent).then(
				() => undefined,
				(error: unknown) => error,
			);
		const first = outcome(sendWithTicket(fixture, ticket));
		await ended;
		const joined = deliveryEnded(fixture, ticket);
		const again = outcome(sendWithTicket(fixture, ticket));
		await joined;

		// When the queue is cleared before the queued message is written
		fixture.h.session.clearQueue();
		fixture.releaseTool();
		await running;
		await settle(fixture);

		// Then both sends settle as cleared, nothing was written for the batch, and the producer keeps its ticket with
		// no payload, so it decides whether to send again (senpi#3864's cleared-delivery rule)
		const [firstOutcome, againOutcome] = await settlesWithin(Promise.all([first, again]), "cleared receipts");
		expect(firstOutcome).toBeInstanceOf(QueuedDeliveryCleared);
		expect(againOutcome).toBeInstanceOf(QueuedDeliveryCleared);
		expect(
			fixture.h.session.messages.some((message) => message.role === "custom" && message.customType === WAKE),
		).toBe(false);
		const record = fixture.h.session.workObligations.active.find((active) => active.ticketId === ticket);
		expect(record?.delivery).toBe("retired");
	});

	it("refuses a re-send with different items into a carrier restored without a watcher, from its custody payload", async () => {
		// Given a ticket whose queued batch [a, b] was restored from custody and re-sent plain, as restart redelivery does
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:restored");
		const toolStarted = fixture.toolStarted();
		const running = fixture.h.session.prompt("start");
		await toolStarted;
		const obligations = fixture.h.session.workObligations;
		const message = { customType: WAKE, content: "Task A finished\n\nTask B finished", display: false };
		obligations.queue(ticket, { message, deliverAs: "followUp", itemIds: ["a", "b"] });
		obligations.endDelivery(ticket);
		await fixture.h.session.sendCustomMessage(message, { triggerTurn: true, deliverAs: "followUp", ticket });

		// When the producer re-sends the ticket with an item that carrier does not carry
		const other: readonly SendMessageItem[] = [{ itemId: "c", producer: "task", content: "Task C finished" }];
		const again = Promise.resolve(sendWithTicket(fixture, ticket, other)).then(
			() => undefined,
			(error: unknown) => error,
		);
		fixture.releaseTool();
		await running;
		await settle(fixture);

		// Then the re-send is refused instead of receiving a receipt for an item that was never written
		expect(await settlesWithin(again, "re-send refusal")).toBeInstanceOf(DeliveryTicketRefused);
	});

	it("does not treat a batch with a duplicate id as the same as one with a different id", async () => {
		// Given a queued batch whose producer sent item a twice
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:duplicate");
		const toolStarted = fixture.toolStarted();
		const running = fixture.h.session.prompt("start");
		await toolStarted;
		const ended = deliveryEnded(fixture, ticket);
		const doubled: readonly SendMessageItem[] = [
			{ itemId: "a", producer: "task", content: "Task A finished" },
			{ itemId: "a", producer: "task", content: "Task A finished again" },
		];
		const first = Promise.resolve(sendWithTicket(fixture, ticket, doubled)).catch(() => undefined);
		await ended;

		// When the producer re-sends the ticket as [a, b]
		const again = Promise.resolve(sendWithTicket(fixture, ticket)).then(
			() => undefined,
			(error: unknown) => error,
		);
		fixture.releaseTool();
		await running;
		await settle(fixture);
		await first;

		// Then item b gets no receipt: the re-send is refused
		expect(await settlesWithin(again, "re-send refusal")).toBeInstanceOf(DeliveryTicketRefused);
	});

	it("settles the queued batch when an abort during a re-send retires the ticket and removes its queued message", async () => {
		// Given a running turn, a ticketed batch queued behind it, and a re-send held while its header is persisted
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:abort-retire");
		const toolStarted = fixture.toolStarted();
		const running = fixture.h.session.prompt("start");
		await toolStarted;
		const ended = deliveryEnded(fixture, ticket);
		const first = Promise.resolve(sendWithTicket(fixture, ticket)).then(
			() => undefined,
			(error: unknown) => error,
		);
		await ended;
		const manager = fixture.h.session.sessionManager;
		const persistHeaderNow = manager.persistHeaderNow.bind(manager);
		const headerHeld = Promise.withResolvers<void>();
		const headerReached = Promise.withResolvers<void>();
		vi.spyOn(manager, "persistHeaderNow").mockImplementationOnce(async () => {
			headerReached.resolve();
			await headerHeld.promise;
			return persistHeaderNow();
		});
		const again = Promise.resolve(sendWithTicket(fixture, ticket)).then(
			() => undefined,
			(error: unknown) => error,
		);
		await headerReached.promise;

		// When the person aborts while the re-send waits, so the re-send retires the ticket and removes the queued message
		await fixture.h.session.abort();
		headerHeld.resolve();
		fixture.releaseTool();
		await running.catch(() => undefined);
		await settle(fixture);
		await again;

		// Then the first send settles as cleared instead of waiting forever on a message that will never be written
		expect(await settlesWithin(first, "first send after its carrier was removed")).toBeInstanceOf(
			QueuedDeliveryCleared,
		);
	});

	it("rejects a re-send whose queued carrier a clear removed while it waited, instead of writing the retired ticket", async () => {
		// Given a running turn, a ticketed batch queued behind it, and a re-send held while its header is persisted
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:clear-race");
		const toolStarted = fixture.toolStarted();
		const running = fixture.h.session.prompt("start");
		await toolStarted;
		const ended = deliveryEnded(fixture, ticket);
		const first = Promise.resolve(sendWithTicket(fixture, ticket)).catch(() => undefined);
		await ended;
		const manager = fixture.h.session.sessionManager;
		const persistHeaderNow = manager.persistHeaderNow.bind(manager);
		const headerHeld = Promise.withResolvers<void>();
		const headerReached = Promise.withResolvers<void>();
		vi.spyOn(manager, "persistHeaderNow").mockImplementationOnce(async () => {
			headerReached.resolve();
			await headerHeld.promise;
			return persistHeaderNow();
		});
		const again = Promise.resolve(sendWithTicket(fixture, ticket)).then(
			() => undefined,
			(error: unknown) => error,
		);
		await headerReached.promise;

		// When the queue is cleared while the re-send waits
		fixture.h.session.clearQueue();
		headerHeld.resolve();
		fixture.releaseTool();
		await running;
		await settle(fixture);
		await first;

		// Then the re-send is rejected as cleared and nothing is written with the retired ticket
		expect(await settlesWithin(again, "re-send after the clear")).toBeInstanceOf(QueuedDeliveryCleared);
		expect(
			fixture.h.session.messages.some((message) => message.role === "custom" && message.customType === WAKE),
		).toBe(false);
	});

	it("settles a re-send with the written entry when the running turn wrote its queued carrier while it waited", async () => {
		// Given a running turn, a ticketed batch queued behind it, and a re-send held while its header is persisted
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:written-race");
		const toolStarted = fixture.toolStarted();
		const running = fixture.h.session.prompt("start");
		await toolStarted;
		const ended = deliveryEnded(fixture, ticket);
		const first = Promise.resolve(sendWithTicket(fixture, ticket)).then(
			(receipts) => receipts,
			(error: unknown) => error,
		);
		await ended;
		const manager = fixture.h.session.sessionManager;
		const persistHeaderNow = manager.persistHeaderNow.bind(manager);
		const headerHeld = Promise.withResolvers<void>();
		const headerReached = Promise.withResolvers<void>();
		vi.spyOn(manager, "persistHeaderNow").mockImplementationOnce(async () => {
			headerReached.resolve();
			await headerHeld.promise;
			return persistHeaderNow();
		});
		const again = Promise.resolve(sendWithTicket(fixture, ticket)).then(
			(receipts) => receipts,
			(error: unknown) => error,
		);
		await headerReached.promise;

		// When the running turn ends and writes the queued message before the re-send continues
		fixture.releaseTool();
		await running;
		await settle(fixture);
		headerHeld.resolve();
		const [firstOutcome, againOutcome] = await settlesWithin(Promise.all([first, again]), "written-race receipts");

		// Then both sends get the written entry's receipts and the message is written once
		expect(againOutcome).not.toBeInstanceOf(Error);
		const firstReceipts = firstOutcome as readonly SendMessageReceipt[];
		const againReceipts = againOutcome as readonly SendMessageReceipt[];
		expect(againReceipts.map((receipt) => receipt.itemId)).toEqual(["a", "b"]);
		expect(firstReceipts.map((receipt) => receipt.itemId)).toEqual(["a", "b"]);
		const writtenEntryId = firstReceipts[0]?.entryId;
		expect(writtenEntryId).toBeDefined();
		expect(againReceipts.map((receipt) => receipt.entryId)).toEqual([writtenEntryId, writtenEntryId]);
		expect(writtenEntries(fixture)).toBe(0);
		expect(
			fixture.h.session.messages.filter((message) => message.role === "custom" && message.customType === WAKE),
		).toHaveLength(1);
	});

	it("does not write a plain re-send whose queued carrier a clear removed while it waited", async () => {
		// Given a running turn, a plain ticketed message queued behind it, and a plain re-send held while its header is
		// persisted
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:plain-clear-race");
		const toolStarted = fixture.toolStarted();
		const running = fixture.h.session.prompt("start");
		await toolStarted;
		const ended = deliveryEnded(fixture, ticket);
		const sendPlain = () =>
			fixture
				.api()
				.sendMessage(
					{ customType: WAKE, content: "Task A finished", display: false },
					{ triggerTurn: true, deliverAs: "followUp", ticket },
				);
		const first = Promise.resolve(sendPlain()).catch(() => undefined);
		await ended;
		const manager = fixture.h.session.sessionManager;
		const persistHeaderNow = manager.persistHeaderNow.bind(manager);
		const headerHeld = Promise.withResolvers<void>();
		const headerReached = Promise.withResolvers<void>();
		vi.spyOn(manager, "persistHeaderNow").mockImplementationOnce(async () => {
			headerReached.resolve();
			await headerHeld.promise;
			return persistHeaderNow();
		});
		const again = Promise.resolve(sendPlain()).then(
			() => undefined,
			(error: unknown) => error,
		);
		await headerReached.promise;

		// When the queue is cleared while the re-send waits
		fixture.h.session.clearQueue();
		headerHeld.resolve();
		fixture.releaseTool();
		await running;
		await settle(fixture);
		await first;
		await settlesWithin(again, "plain re-send after the clear");

		// Then nothing is written with the retired ticket
		expect(
			fixture.h.session.messages.some((message) => message.role === "custom" && message.customType === WAKE),
		).toBe(false);
	});

	it("keeps no written-carrier entry once each ticketed delivery has been written", async () => {
		// Given an idle session
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		fixture.h.setResponses(Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(`reply ${index}`)));

		// When three ticketed batches are each delivered, written and their tickets retire
		for (const key of ["result:retire-1", "result:retire-2", "result:retire-3"]) {
			const receipts = await sendWithTicket(fixture, openTicket(fixture, key));
			expect(receipts?.map((receipt) => receipt.disposition)).toEqual(["message_persisted", "message_persisted"]);
			await settle(fixture);
		}

		// Then the session keeps no written-carrier entry for any of them
		expect(writtenEntries(fixture)).toBe(0);
	});
});
