import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
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

// senpi#5922: admission reads `getOwnership()`, and the write path reads the same fold through `_persist`. A
// session that persists nothing never reaches the write guard, so ownership must not refuse it either.
describe("SessionManager.getOwnership", () => {
	it("#given an in-memory session holding a move release #then it stays writable, as its writes do", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(SESSION_RELEASED, { reason: "move", move_id: "m1", target: "laptop" });
		expect(manager.getOwnership()).toEqual({ writable: true });
	});

	it("#given an in-memory session holding session_moved #then it stays writable, as its writes do", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(SESSION_MOVED, { move_id: "m1", target: "laptop" });
		expect(manager.getOwnership()).toEqual({ writable: true });
	});

	it("#given a persisted session holding session_moved #then it stays read-only", () => {
		const root = mkdtempSync(join(tmpdir(), "5922-ownership-"));
		try {
			const manager = SessionManager.create(root, join(root, "sessions"));
			manager.appendCustomEntry(SESSION_RELEASED, { reason: "move", move_id: "m1", target: "laptop" });
			manager.appendCustomEntry(SESSION_MOVED, { move_id: "m1", target: "laptop" });
			expect(manager.getOwnership()).toMatchObject({ writable: false, state: "moved" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
