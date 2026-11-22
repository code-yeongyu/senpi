import { describe, expect, it } from "vitest";
import { heldRosterView, type RosterView, rosterViewAt } from "../../src/core/egress/roster-entries.ts";

const IAT = 1_000_000;
const EXP = IAT + 15 * 60_000;
const RECEIVED_MONO = 500;

const view = (overrides: Partial<Extract<RosterView, { state: "known" }>> = {}): RosterView => ({
	state: "known",
	serviceEntries: [],
	rosterVersion: 4,
	rosterIssuedAt: IAT,
	rosterExpiresAt: EXP,
	receivedMono: RECEIVED_MONO,
	...overrides,
});

describe("rosterViewAt (custody design 15.15 H-1, 15.16 M-1)", () => {
	// Design 15.15 H-1 / 15.16 M-1: "The view is unknown at the earlier of (i) receivedMono + (exp - iat) elapsed on the
	// monotonic clock and (ii) effectiveNow >= exp on the wall clock, with effectiveNow = max(now, rosterIssuedAt)".
	it("roster-age-bounded: known until the monotonic lifetime since receipt, unknown from then on", () => {
		const lifetime = EXP - IAT;
		expect(rosterViewAt(view(), IAT, RECEIVED_MONO + lifetime - 1)).toEqual(view());
		expect(rosterViewAt(view(), IAT, RECEIVED_MONO + lifetime)).toEqual({ state: "unknown" });
	});

	it("roster-age-bounded: unknown at exp on the wall clock even while the monotonic clock stood still (sleep)", () => {
		expect(rosterViewAt(view(), EXP - 1, RECEIVED_MONO)).toEqual(view());
		expect(rosterViewAt(view(), EXP, RECEIVED_MONO)).toEqual({ state: "unknown" });
	});

	it("roster-age-survives-clock-rollback: a wall clock rolled back below iat cannot extend the view", () => {
		const lifetime = EXP - IAT;
		expect(rosterViewAt(view(), IAT - 3_600_000, RECEIVED_MONO + lifetime)).toEqual({ state: "unknown" });
	});

	it("is unknown when the monotonic clock reads before the receipt (another process or a restart)", () => {
		expect(rosterViewAt(view(), IAT, RECEIVED_MONO - 1)).toEqual({ state: "unknown" });
	});

	it("keeps an unknown view unknown", () => {
		expect(rosterViewAt({ state: "unknown" }, IAT, RECEIVED_MONO)).toEqual({ state: "unknown" });
	});
});

describe("heldRosterView (custody design 15.15 H-1, 15.16 M-2)", () => {
	// Design 15.15 H-1 / 15.16 M-2: "rosterIssuedAt, rosterExpiresAt and receivedMono change only for a verified roster
	// that is strictly newer than the one held - a higher rv, or the same rv with a later iat".
	it("roster-replay-does-not-refresh: an identical or older roster leaves the held view untouched", () => {
		const held = view();
		expect(heldRosterView(held, view({ receivedMono: RECEIVED_MONO + 60_000 }))).toBe(held);
		expect(heldRosterView(held, view({ rosterVersion: 3, rosterIssuedAt: IAT + 1, receivedMono: 9_999 }))).toBe(held);
		expect(heldRosterView(held, view({ rosterIssuedAt: IAT - 1, receivedMono: 9_999 }))).toBe(held);
	});

	it("takes a strictly newer roster: a higher rv, or the same rv with a later iat", () => {
		const held = view();
		const higher = view({ rosterVersion: 5, rosterIssuedAt: IAT - 1 });
		const later = view({ rosterIssuedAt: IAT + 300_000, rosterExpiresAt: EXP + 300_000 });
		expect(heldRosterView(held, higher)).toBe(higher);
		expect(heldRosterView(held, later)).toBe(later);
		expect(heldRosterView({ state: "unknown" }, held)).toBe(held);
	});
});
