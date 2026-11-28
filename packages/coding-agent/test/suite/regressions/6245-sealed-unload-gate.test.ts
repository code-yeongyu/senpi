// senpi#6245: the attachment gate lets an unattached connection unload a session ONLY when that session is sealed by
// output overflow (senpi#3913): such a session has dropped every attachment and refuses reattach, so its unload is the
// one way back. Every other unattached command, and an unload of any other session, still gets the gate's refusal.
// The real router path (an unattached peer unloading a sealed session) is 3913-sealed-reattach.test.ts.
import { describe, expect, it } from "vitest";
import { attachmentGate } from "../../../src/modes/rpc/session-attachment-gate.ts";

const CALLER = "conn-caller";
const OTHER = "conn-other";
const NOT_ATTACHED = { success: false, errorCode: "session_not_attached" };

function host(sealed: readonly string[], attachments: Record<string, readonly string[]> = {}) {
	return {
		allowUnattached: false,
		sessionsByConnection: new Map(Object.entries(attachments).map(([owner, ids]) => [owner, new Set(ids)])),
		writer: {
			currentConnection: () => CALLER,
			recoveryPages: undefined,
			isSessionSealed: (sessionId: string) => sealed.includes(sessionId),
		},
	};
}

const unload = (sessionId: string) => ({ id: "u1", type: "unload_session", sessionId, force: true });
const gate = (rig: ReturnType<typeof host>, command: object) => attachmentGate(rig as never, command as never);

describe("senpi#6245 the attachment gate and a session sealed by output overflow", () => {
	it("lets an unattached connection unload a sealed session", () => {
		expect(gate(host(["sealed"]), unload("sealed"))).toBeUndefined();
	});

	it("refuses an unattached unload of a live session", () => {
		expect(gate(host([]), unload("live"))).toMatchObject(NOT_ATTACHED);
	});

	it("refuses an unattached unload of a live session another connection holds", () => {
		expect(gate(host([], { [OTHER]: ["held"] }), unload("held"))).toMatchObject(NOT_ATTACHED);
	});

	it("refuses an unattached unload of a handle the host does not have", () => {
		expect(gate(host(["sealed"]), unload("missing"))).toMatchObject(NOT_ATTACHED);
	});

	it("refuses every other unattached command on a sealed session", () => {
		for (const command of [
			{ id: "p1", type: "prompt", sessionId: "sealed", message: "x" },
			{ id: "a1", type: "abort", sessionId: "sealed" },
			{ id: "c1", type: "compact", sessionId: "sealed" },
		])
			expect(gate(host(["sealed"]), command), command.type).toMatchObject(NOT_ATTACHED);
	});
});
