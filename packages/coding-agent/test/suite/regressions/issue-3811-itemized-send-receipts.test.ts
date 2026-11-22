import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SendMessageItem, SendMessageReceipt } from "../../../src/core/extensions/types.ts";
import { type ResumeFixture, resumeFixture, settle, settlesWithin } from "./issue-3811-resume-support.ts";

const WAKE = "omo-senpi:wake";
const fencedRun = { kind: "task", id: "t1" } as const;

async function textFixture(): Promise<ResumeFixture> {
	const fixture = await resumeFixture();
	fixture.h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	return fixture;
}

async function sendItems(
	fixture: ResumeFixture,
	items: readonly SendMessageItem[],
): Promise<readonly SendMessageReceipt[]> {
	const content = items.map((item) => String(item.content)).join("\n\n");
	const receipts = await fixture
		.api()
		.sendMessage({ customType: WAKE, content, display: false }, { triggerTurn: true, deliverAs: "followUp", items });
	// The agent session has item custody, so an itemized send must answer receipts here.
	if (receipts === undefined) throw new Error("an itemized send on a session with item custody answered no receipts");
	return receipts;
}

function nextTurnStart(fixture: ResumeFixture): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = fixture.h.session.subscribe((event) => {
			if (event.type !== "agent_start") return;
			unsubscribe();
			resolve();
		});
	});
}

/** Every stored notice with the entry that holds it; a held batch is one entry holding one notice per item. */
function heldNotices(fixture: ResumeFixture): Array<{ entryId: string; notice: Record<string, unknown> }> {
	return fixture.h.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== "session-notice") return [];
		const data = entry.data as { notices?: Array<Record<string, unknown>> } & Record<string, unknown>;
		return (data.notices ?? [data]).map((notice) => ({ entryId: entry.id, notice }));
	});
}

/** Every `session-notice` write that carries `itemId` fails, as a full disk would fail it. */
function failNoticeWritesCarrying(fixture: ResumeFixture, itemId: string): void {
	const manager = fixture.h.sessionManager;
	const append = manager.appendCustomEntry.bind(manager);
	manager.appendCustomEntry = (customType, data, options) => {
		if (customType === "session-notice" && JSON.stringify(data).includes(`"itemId":"${itemId}"`))
			throw new Error("disk full");
		return append(customType, data, options);
	};
}

const twoItems: readonly SendMessageItem[] = [
	{ itemId: "a", producer: "task", content: "Task A finished" },
	{ itemId: "b", producer: "task", content: "Task B finished" },
];

function sendTwoItems(fixture: ResumeFixture): unknown {
	return fixture
		.api()
		.sendMessage(
			{ customType: WAKE, content: "Task A finished\n\nTask B finished", display: false },
			{ triggerTurn: true, deliverAs: "followUp", items: twoItems },
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

	it("splits a batch a Stop holds into one notice and one receipt per item, written as one entry", async () => {
		// Given a stopped session
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();

		// When a coordinator sends a batch of two items
		const receipts = await sendItems(fixture, [
			{ itemId: "a", producer: "task", content: "Task A finished" },
			{ itemId: "b", producer: "task", content: "Task B finished" },
		]);

		// Then no turn started and each item is its own stored notice with its own content and receipt, in one entry
		expect(fixture.h.faux.state.callCount).toBe(0);
		const notices = heldNotices(fixture);
		expect(notices).toHaveLength(2);
		expect(new Set(notices.map((held) => held.entryId)).size).toBe(1);
		expect(receipts).toEqual([
			{
				itemId: "a",
				entryId: notices[0]?.entryId,
				disposition: "notice_persisted",
				noticeId: notices[0]?.notice.noticeId,
			},
			{
				itemId: "b",
				entryId: notices[1]?.entryId,
				disposition: "notice_persisted",
				noticeId: notices[1]?.notice.noticeId,
			},
		]);
		expect(JSON.stringify(notices[0]?.notice.message)).toContain("Task A finished");
		expect(JSON.stringify(notices[0]?.notice.message)).not.toContain("Task B finished");
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
		expect(heldNotices(fixture)).toHaveLength(2);
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

	it("rejects a held batch whose notice write fails and keeps none of its items in custody", async () => {
		// Given a stopped session whose notice write for the second item fails
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();
		failNoticeWritesCarrying(fixture, "b");

		// When a coordinator sends a batch of two items
		let sending: unknown;
		expect(() => {
			sending = sendTwoItems(fixture);
		}).not.toThrow();

		// Then the receipts reject and neither item is in custody, so the sender can retry the whole batch
		await expect(settlesWithin(Promise.resolve(sending), "the held batch's receipts")).rejects.toThrow("disk full");
		expect(heldNotices(fixture)).toEqual([]);
		expect(persistedNotices(fixture)).toBe(0);
		expect(fixture.h.session.pausedNoticeCount).toBe(0);
	});

	it("rejects the receipts of a held batch sent from agent_settled when its notice write fails", async () => {
		// Given a running turn and an extension that sends a batch from agent_settled once the turn is stopped
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		let armed = false;
		let sending: unknown;
		fixture.api().on("agent_settled", () => {
			if (!armed) return;
			armed = false;
			sending = sendTwoItems(fixture);
		});
		failNoticeWritesCarrying(fixture, "b");
		const toolStarted = fixture.toolStarted();
		const prompt = fixture.h.session.prompt("Work on it");
		await toolStarted;

		// When the user stops the turn, so the deferred batch is admitted while the Stop holds the session
		armed = true;
		const stop = fixture.h.session.stop();
		fixture.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);

		// Then the deferred admission still answers: its receipts reject and no item is in custody
		expect(sending).toBeDefined();
		await expect(settlesWithin(Promise.resolve(sending), "the deferred batch's receipts")).rejects.toThrow(
			"disk full",
		);
		expect(heldNotices(fixture)).toEqual([]);
		expect(fixture.h.session.pausedNoticeCount).toBe(0);
	});

	it("keeps a plain sendMessage without items fire-and-forget", async () => {
		// Given a session nothing holds
		const fixture = await textFixture();
		fixtures.push(fixture);

		// When an extension sends a message without items
		// (a plain send answers nothing to await, and its turn starts only after async admission, so wait for that start)
		const started = nextTurnStart(fixture);
		const result: unknown = fixture
			.api()
			.sendMessage({ customType: WAKE, content: "plain wake", display: false }, { triggerTurn: true });
		await settlesWithin(started, "the plain wake's turn");
		await settle(fixture);

		// Then nothing is returned and the turn still runs
		expect(result).toBeUndefined();
		expect(fixture.h.faux.state.callCount).toBe(1);
	});
});
