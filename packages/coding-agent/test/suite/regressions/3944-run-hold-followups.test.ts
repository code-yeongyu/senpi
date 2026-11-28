/**
 * senpi#3944: follow-ups from the #3871 review of Stop and run pauses. Each case is one item of the issue.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { HumanInputAdmittedEvent } from "../../../src/core/agent-session.ts";
import { EngineTurnHold, type SessionHoldEvent } from "../../../src/core/engine-turn-hold.ts";
import { releaseQuestionInput } from "../../../src/core/question-input.ts";
import { RunHolds } from "../../../src/core/run-holds.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { type ResumeFixture, resumeFixture, runRef, settle } from "./issue-3811-resume-support.ts";

function ledger(entries: SessionEntry[] = []) {
	const events: SessionHoldEvent[] = [];
	const append = (customType: string, data: unknown): string => {
		const id = `e${entries.length + 1}`;
		entries.push({
			type: "custom",
			id,
			parentId: null,
			timestamp: "2026-11-23T00:00:00.000Z",
			customType,
			data,
		} as SessionEntry);
		return id;
	};
	const hold = new EngineTurnHold(
		entries,
		false,
		append,
		() => {},
		(event) => events.push(event),
	);
	return { entries, events, hold, runs: new RunHolds(hold) };
}

const owner = { parentSessionId: "parent", runRef: { kind: "dag", id: "r1" } } as const;

describe("senpi#3944 run-hold follow-ups", () => {
	const fixtures: ResumeFixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			await fixture.h.session.abort();
			fixture.h.cleanup();
		}
	});

	// Item 3: a parent's newer pause raises the inherited hold in place; the session never stopped being held.
	it("#given an inherited hold #when the parent's pause seq rises #then the hold is replaced in place with no resumed/paused pair", () => {
		const { events, hold, runs, entries } = ledger();
		runs.inherit({ ...owner, parentPauseSeq: 1 });
		const before = events.length;

		const raised = runs.inherit({ ...owner, parentPauseSeq: 2 });

		expect(events.slice(before)).toEqual([]);
		expect(hold.isHeld()).toBe(true);
		expect(raised).toEqual({ childSeq: hold.currentPauseSeq });
		expect(runs.inheritedOwner()).toEqual({ ...owner, highWater: 2 });
		// A reopen replays the replacement: the raised high-water mark survives and the old seq stays stale.
		const reopened = ledger(entries);
		expect(reopened.runs.inheritedOwner()).toEqual({ ...owner, highWater: 2 });
		expect(
			reopened.runs.releaseInherited({ parentSessionId: "parent", parentPauseSeq: 1, childSeqCutoff: 9 }),
		).toEqual({
			released: false,
			reason: "stale",
		});
	});

	// Item 1: each per-item notice event reports the count after its own item, as the stored notice does.
	it("#given an itemized batch of three #when it is held #then each session_notice carries a running count", () => {
		const { events, hold } = ledger();
		hold.addHold("session_hold");
		const message = { role: "custom", customType: "test", content: "x", display: false, timestamp: 1 } as const;
		const before = events.length;

		hold.noteItems(["a", "b", "c"].map((itemId) => ({ source: "dag", message, item: { itemId } })));

		const counts = events
			.slice(before)
			.flatMap((event) => (event.type === "session_notice" ? [event.noticeCount] : []));
		expect(counts).toEqual([1, 2, 3]);
	});

	// Item 4: a question answer under a parent's run pause is reported as human input once.
	it("#given a child under its parent's run pause #when a person's question answer arrives #then human input is reported once", async () => {
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const paused = await fixture.h.session.pauseForRun({ parentSessionId: "p", parentPauseSeq: 1, runRef });
		if (!("childSeq" in paused)) throw new Error("pause_for_run was refused");
		const seen: HumanInputAdmittedEvent["kind"][] = [];
		fixture.h.session.onHumanInputAdmitted((event) => seen.push(event.kind));

		releaseQuestionInput(fixture.h.session.extensionRunner.createContext());
		fixture.api().sendUserMessage("Answer: use staging", { deliverAs: "followUp" });
		await settle(fixture);

		expect(fixture.h.session.pausedHeldInputCount).toBe(1);
		expect(seen).toEqual(["answer"]);
	});

	// Item 2: a held command that ran is never restored, whether its release completes or a newer Stop overtakes it.
	it("#given a held command released once #when a newer Stop and a second release follow #then the command ran exactly once", async () => {
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		fixture.h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const ran: string[] = [];
		fixture.api().registerCommand("note", {
			description: "Record a note",
			handler: async (args) => {
				ran.push(args);
			},
		});
		const paused = await fixture.h.session.pauseForRun({ parentSessionId: "p", parentPauseSeq: 1, runRef });
		if (!("childSeq" in paused)) throw new Error("pause_for_run was refused");
		await fixture.h.session.prompt("/note once");
		await fixture.h.session.stop();
		await fixture.h.session.resumeForRun({
			parentSessionId: "p",
			parentPauseSeq: 1,
			childSeqCutoff: paused.childSeq,
		});

		await fixture.h.session.prompt("first release");
		await fixture.h.session.stop();
		await fixture.h.session.prompt("second release");
		await settle(fixture);

		expect(ran).toEqual(["once"]);
	});
});
