import { describe, expect, it } from "vitest";
import { EngineTurnHold } from "../../../src/core/engine-turn-hold.ts";
import { RunHolds } from "../../../src/core/run-holds.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";

function session(entries: SessionEntry[] = []) {
	const append = (customType: string, data: unknown): void => {
		entries.push({
			type: "custom",
			id: `e${entries.length + 1}`,
			parentId: null,
			timestamp: "2026-10-21T00:00:00.000Z",
			customType,
			data,
		} as SessionEntry);
	};
	const hold = new EngineTurnHold(
		entries,
		false,
		append,
		() => {},
		() => {},
	);
	return { entries, hold, runs: new RunHolds(hold) };
}

const run = { kind: "dag", id: "r1" } as const;
const owner = { parentSessionId: "parent", runRef: run };

describe("senpi#3811 run holds", () => {
	it("holds only wakes tagged with a fenced run on a parent", () => {
		const { runs } = session();
		runs.fence(run);

		expect(runs.holdsWake({ runRef: run })).toBe(true);
		expect(runs.holdsWake({ runRef: { kind: "dag", id: "other" } })).toBe(false);
		expect(runs.holdsWake(undefined)).toBe(false);
	});

	it("raises an inherited hold to a newer parent seq and refuses a stale release", () => {
		const { runs } = session();
		expect(runs.inherit({ ...owner, parentPauseSeq: 1 })).toEqual({ childSeq: 1 });
		runs.inherit({ ...owner, parentPauseSeq: 2 });

		expect(runs.releaseInherited({ parentSessionId: "parent", parentPauseSeq: 1, childSeqCutoff: 1 })).toEqual({
			released: false,
			reason: "stale",
		});
		expect(runs.releaseInherited({ parentSessionId: "parent", parentPauseSeq: 2, childSeqCutoff: 1 })).toEqual({
			released: true,
			otherHoldLive: false,
		});
	});

	it("refuses a release from a parent that did not pause this child", () => {
		const { runs } = session();
		runs.inherit({ ...owner, parentPauseSeq: 1 });

		expect(runs.inherit({ parentSessionId: "intruder", runRef: run, parentPauseSeq: 5 })).toEqual({
			refused: "wrong_parent",
		});
		expect(runs.releaseInherited({ parentSessionId: "intruder", parentPauseSeq: 1, childSeqCutoff: 9 })).toEqual({
			released: false,
			reason: "wrong_parent",
		});
	});

	it("releases a direct Stop the parent observed, and keeps one added after its cutoff", () => {
		const observed = session();
		observed.runs.stamp();
		const childSeq = observed.runs.inherit({ ...owner, parentPauseSeq: 1 });
		expect(
			observed.runs.releaseInherited({
				parentSessionId: "parent",
				parentPauseSeq: 1,
				childSeqCutoff: "childSeq" in childSeq ? childSeq.childSeq : 0,
			}),
		).toEqual({ released: true, otherHoldLive: false });
		expect(observed.hold.isHeld()).toBe(false);

		const later = session();
		const ack = later.runs.inherit({ ...owner, parentPauseSeq: 1 });
		later.runs.stamp();
		expect(
			later.runs.releaseInherited({
				parentSessionId: "parent",
				parentPauseSeq: 1,
				childSeqCutoff: "childSeq" in ack ? ack.childSeq : 0,
			}),
		).toEqual({ released: true, otherHoldLive: true });
		expect(later.hold.isHeld()).toBe(true);
	});

	it("survives a reopen with the inherited owner and high-water mark", () => {
		const first = session();
		first.runs.inherit({ ...owner, parentPauseSeq: 3 });

		const reopened = session(first.entries);

		expect(reopened.runs.inheritedOwner()).toEqual({ parentSessionId: "parent", runRef: run, highWater: 3 });
		expect(
			reopened.runs.releaseInherited({ parentSessionId: "parent", parentPauseSeq: 2, childSeqCutoff: 9 }),
		).toEqual({ released: false, reason: "stale" });
	});
});
