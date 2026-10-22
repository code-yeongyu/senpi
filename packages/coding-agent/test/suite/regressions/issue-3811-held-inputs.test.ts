import { describe, expect, it } from "vitest";
import { HeldInputs } from "../../../src/core/held-inputs.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";

function ledger() {
	const entries: SessionEntry[] = [];
	const append = (customType: string, data: unknown): string => {
		const id = `e${entries.length + 1}`;
		entries.push({
			type: "custom",
			id,
			parentId: null,
			timestamp: "2026-10-21T00:00:00.000Z",
			customType,
			data,
		} as SessionEntry);
		return id;
	};
	return { entries, append };
}

describe("senpi#3811 held human input", () => {
	it("stores the same input id and revision once", () => {
		const { entries, append } = ledger();
		const held = new HeldInputs([], append);

		const first = held.hold({ inputId: "g1", revision: 1, text: "use the staging db" });
		const replay = held.hold({ inputId: "g1", revision: 1, text: "use the staging db" });

		expect(first).toEqual({ kind: "held", entryId: "e1", duplicate: false });
		expect(replay).toEqual({ kind: "held", entryId: "e1", duplicate: true });
		expect(entries).toHaveLength(1);
	});

	it("refuses a new revision under an input id that is already held", () => {
		const { append } = ledger();
		const held = new HeldInputs([], append);
		held.hold({ inputId: "g1", revision: 1, text: "first" });

		expect(held.hold({ inputId: "g1", revision: 2, text: "second" })).toEqual({
			kind: "input_id_conflict",
			heldRevision: 1,
		});
		expect(held.pending().map((input) => input.text)).toEqual(["first"]);
	});

	it("survives a reopen and never redelivers consumed or withdrawn input", () => {
		const { entries, append } = ledger();
		const held = new HeldInputs([], append);
		held.hold({ inputId: "a", revision: 1, text: "kept" });
		held.hold({ inputId: "b", revision: 1, text: "withdrawn" });
		held.hold({ inputId: "c", revision: 1, text: "delivered" });
		held.withdraw("b");
		held.consume(["c"]);

		const reopened = new HeldInputs(entries, append);

		expect(reopened.pending().map((input) => input.inputId)).toEqual(["a"]);
		expect(reopened.hold({ inputId: "c", revision: 1, text: "delivered" })).toEqual({
			kind: "already_delivered",
			revision: 1,
		});
		expect(reopened.hold({ inputId: "c", revision: 2, text: "changed" })).toEqual({
			kind: "input_id_conflict",
			heldRevision: 1,
		});
	});
});
