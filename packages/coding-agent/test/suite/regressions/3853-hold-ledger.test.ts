import { expect, it } from "vitest";
import { EngineTurnHold, type SessionHoldEvent } from "../../../src/core/engine-turn-hold.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#3853/#3811: dropping one independently keyed hold must not open admission.
it("releases only named keys and emits resumed only when the last hold goes", () => {
	const manager = SessionManager.inMemory();
	const events: SessionHoldEvent[] = [];
	const makeLedger = () =>
		new EngineTurnHold(
			manager.getEntries(),
			false,
			(type, data) => {
				manager.appendCustomEntry(type, data);
			},
			() => {},
			(event) => {
				events.push(event);
			},
		);
	const ledger = makeLedger();
	ledger.addHold("unattended", { key: "first", data: { owner: "a" } });
	ledger.addHold("unattended", { key: "second", data: { owner: "b" } });
	expect(ledger.getHold("first")).toMatchObject({ kind: "unattended", key: "first", data: { owner: "a" } });
	ledger.release(["first"], "resume_session");
	expect(ledger.isHeld()).toBe(true);
	expect(ledger.getHold("first")).toBeUndefined();
	expect(ledger.getHold("second")).toMatchObject({ key: "second", data: { owner: "b" } });
	expect(events.filter((event) => event.type === "session_resumed")).toEqual([]);
	const reopened = makeLedger();
	expect(reopened.isHeld()).toBe(true);
	expect(reopened.getHold("first")).toBeUndefined();
	expect(reopened.getHold("second")).toMatchObject({ key: "second", data: { owner: "b" } });
	reopened.release(["second"], "input");
	expect(reopened.isHeld()).toBe(false);
	expect(events.filter((event) => event.type === "session_resumed")).toEqual([
		expect.objectContaining({ type: "session_resumed", cause: "input" }),
	]);
	const releases = manager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "session-hold" &&
				(entry.data as { op?: string }).op === "release",
		);
	expect(releases).toMatchObject([
		{ data: { op: "release", keys: ["first"], observedSeq: 2, cause: "resume_session" } },
		{ data: { op: "release", keys: ["second"], observedSeq: 2, cause: "input" } },
	]);
});
