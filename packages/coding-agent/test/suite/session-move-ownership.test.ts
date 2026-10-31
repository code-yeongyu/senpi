import { describe, expect, it } from "vitest";
import {
	SESSION_MOVED,
	SESSION_MOVED_IN,
	SESSION_RECLAIMED,
	SESSION_RELEASED,
	sessionOwnership,
} from "../../src/core/session-move/ownership.ts";

const custom = (customType: string, data: Record<string, unknown>) => ({ type: "custom", customType, data });
const message = { type: "message" };

describe("sessionOwnership", () => {
	it("#given no ownership entry #then the session is writable", () => {
		expect(sessionOwnership([message, message])).toEqual({ writable: true });
	});

	it("#given a takeover release #then the next local writer may continue", () => {
		expect(sessionOwnership([message, custom(SESSION_RELEASED, { reason: "takeover" })])).toEqual({ writable: true });
	});

	it("#given a move release #then the session is read-only while moving", () => {
		const verdict = sessionOwnership([custom(SESSION_RELEASED, { reason: "move", move_id: "m1", target: "laptop" })]);
		expect(verdict).toEqual({ writable: false, state: "moving", moveId: "m1", target: "laptop" });
	});

	it("#given a move release then session_moved #then the session stays read-only as moved", () => {
		const verdict = sessionOwnership([
			custom(SESSION_RELEASED, { reason: "move", move_id: "m1", target: "laptop" }),
			custom(SESSION_MOVED, { move_id: "m1", target: "laptop" }),
		]);
		expect(verdict).toMatchObject({ writable: false, state: "moved" });
	});

	it("#given a move release then session_reclaimed #then the session is writable again", () => {
		const verdict = sessionOwnership([
			custom(SESSION_RELEASED, { reason: "move", move_id: "m1", target: "laptop" }),
			custom(SESSION_RECLAIMED, { move_id: "m1", reason: "declined" }),
		]);
		expect(verdict).toEqual({ writable: true });
	});

	it("#given an imported file ending in session_moved_in after the move release #then the receiver may write", () => {
		const verdict = sessionOwnership([
			message,
			custom(SESSION_RELEASED, { reason: "move", move_id: "m1", target: "laptop" }),
			custom(SESSION_MOVED_IN, { move_id: "m1", from: "desktop" }),
		]);
		expect(verdict).toEqual({ writable: true });
	});
});
