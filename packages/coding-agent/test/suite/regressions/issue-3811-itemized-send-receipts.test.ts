import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SendMessageItem, SendMessageReceipt } from "../../../src/core/extensions/types.ts";
import { type ResumeFixture, resumeFixture, settle } from "./issue-3811-resume-support.ts";

const WAKE = "omo-senpi:wake";
const fencedRun = { kind: "task", id: "t1" } as const;

async function textFixture(): Promise<ResumeFixture> {
	const fixture = await resumeFixture();
	fixture.h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	return fixture;
}

function sendItems(fixture: ResumeFixture, items: readonly SendMessageItem[]): Promise<readonly SendMessageReceipt[]> {
	const content = items.map((item) => String(item.content)).join("\n\n");
	return fixture
		.api()
		.sendMessage({ customType: WAKE, content, display: false }, { triggerTurn: true, deliverAs: "followUp", items });
}

function noticeEntries(fixture: ResumeFixture): Array<{ id: string; data: Record<string, unknown> }> {
	return fixture.h.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "session-notice"
				? [{ id: entry.id, data: entry.data as Record<string, unknown> }]
				: [],
		);
}

function persistedNotices(fixture: ResumeFixture): number {
	return fixture.h
		.eventsOfType("session_notice")
		.filter((event) => event.disposition === "notice_persisted")
		.reduce((sum, event) => sum + event.noticeIds.length, 0);
}

describe("senpi#3811 itemized sendMessage custody", () => {
	const fixtures: ResumeFixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			await fixture.h.session.abort();
			fixture.h.cleanup();
		}
	});

	it("delivers an unheld batch as one message and answers one message_persisted receipt per item", async () => {
		// Given a session nothing holds
		const fixture = await textFixture();
		fixtures.push(fixture);

		// When a coordinator sends a batch of two items
		const receipts = await sendItems(fixture, [
			{ itemId: "a", producer: "task", content: "Task A finished" },
			{ itemId: "b", producer: "team", content: "Team B replied" },
		]);
		await settle(fixture);

		// Then it is one model turn and every item names the one entry that carried it
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(receipts.map((receipt) => [receipt.itemId, receipt.disposition])).toEqual([
			["a", "message_persisted"],
			["b", "message_persisted"],
		]);
		const carrier = fixture.h.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === WAKE);
		expect(carrier).toBeDefined();
		expect(new Set(receipts.map((receipt) => receipt.entryId))).toEqual(new Set([carrier?.id]));
	});

	it("splits a batch a Stop holds into one notice entry and one receipt per item", async () => {
		// Given a stopped session
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();

		// When a coordinator sends a batch of two items
		const receipts = await sendItems(fixture, [
			{ itemId: "a", producer: "task", content: "Task A finished" },
			{ itemId: "b", producer: "task", content: "Task B finished" },
		]);

		// Then no turn started and each item is its own stored notice with its own content and receipt
		expect(fixture.h.faux.state.callCount).toBe(0);
		const notices = noticeEntries(fixture);
		expect(notices).toHaveLength(2);
		expect(receipts).toEqual([
			{ itemId: "a", entryId: notices[0]?.id, disposition: "notice_persisted", noticeId: notices[0]?.data.noticeId },
			{ itemId: "b", entryId: notices[1]?.id, disposition: "notice_persisted", noticeId: notices[1]?.data.noticeId },
		]);
		expect(JSON.stringify(notices[0]?.data.message)).toContain("Task A finished");
		expect(JSON.stringify(notices[0]?.data.message)).not.toContain("Task B finished");
		expect(persistedNotices(fixture)).toBe(2);
		expect(fixture.h.session.pausedNoticeCount).toBe(2);
	});

	it("splits the whole batch when only one item's run is fenced", async () => {
		// Given a session whose run t1 is fenced, which holds only wakes tagged with that run
		const fixture = await textFixture();
		fixtures.push(fixture);
		fixture.api().registerCommand("fence-run", {
			description: "Fence run t1",
			handler: async (_args, ctx) => {
				ctx.fenceRun?.(fencedRun);
			},
		});
		await fixture.h.session.prompt("/fence-run");

		// When a batch carries one item of that run and one untagged item
		const receipts = await sendItems(fixture, [
			{ itemId: "a", producer: "task", runRef: fencedRun, content: "Node of t1 finished" },
			{ itemId: "b", producer: "team", content: "Team B replied" },
		]);

		// Then admission is atomic: both items are held as their own notices
		expect(fixture.h.faux.state.callCount).toBe(0);
		expect(receipts.map((receipt) => receipt.disposition)).toEqual(["notice_persisted", "notice_persisted"]);
		expect(noticeEntries(fixture)).toHaveLength(2);
	});

	it("never lets a later wake from the same producer replace a held item's notice", async () => {
		// Given a stopped session holding one item from the task producer
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();
		await sendItems(fixture, [{ itemId: "a", producer: "task", content: "Task A finished" }]);

		// When a later batch from the same producer is held, and the person releases the Stop
		await sendItems(fixture, [{ itemId: "b", producer: "task", content: "Task B finished" }]);
		await fixture.h.session.prompt("Go on");
		await settle(fixture);

		// Then the releasing turn carries both items
		expect(fixture.h.faux.state.callCount).toBe(1);
		const delivered = JSON.stringify(fixture.h.faux.getCallLog().at(-1)?.context.messages);
		expect(delivered).toContain("Task A finished");
		expect(delivered).toContain("Task B finished");
		expect(fixture.h.session.pausedNoticeCount).toBe(0);
	});

	it("keeps a plain sendMessage without items fire-and-forget", async () => {
		// Given a session nothing holds
		const fixture = await textFixture();
		fixtures.push(fixture);

		// When an extension sends a message without items
		const result: unknown = fixture
			.api()
			.sendMessage({ customType: WAKE, content: "plain wake", display: false }, { triggerTurn: true });
		await settle(fixture);

		// Then nothing is returned and the turn still runs
		expect(result).toBeUndefined();
		expect(fixture.h.faux.state.callCount).toBe(1);
	});
});
