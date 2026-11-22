import { describe, expect, it } from "vitest";

// omo#12965 (design amendment 3.2-A1): the codemode cell-authority registry is a cross-version contract. A copy adopts
// the realm's instance whichever codemode version created it, so it validates what that instance hands back and
// refuses when it cannot read it. This file's realm gets an instance from "another version" before any codemode module
// loads: its members exist, but its session handles and its snapshot list have shapes this copy does not know.

const KEY = Symbol.for("@code-yeongyu/senpi/codemode-cell-authority/v1");

const live = { dead: () => false, markDead: () => {}, pending: () => undefined };
const handles: Record<string, unknown> = {
	"x12965-no-functions": { state: "live" },
	"x12965-pending-not-a-promise": { ...live, pending: () => "soon" },
	"x12965-dead-not-a-boolean": { ...live, dead: () => undefined },
	"x12965-readable": live,
};

Object.defineProperty(globalThis, KEY, {
	value: Object.freeze({
		registerInvocation: () => () => {},
		invocations: () => "one snapshot per kernel",
		registerKernel: (sessionId: string) => handles[sessionId],
		unregisterKernel: () => {},
		revoke: async () => {},
	}),
	writable: false,
	configurable: false,
	enumerable: false,
});

describe("codemode cell authority handed back by another version's registry (omo#12965)", () => {
	it.each(["x12965-no-functions", "x12965-pending-not-a-promise", "x12965-dead-not-a-boolean"])(
		"reads a session whose handle it cannot read as dead (%s)",
		async (sessionId) => {
			const sessions = await import("../src/kernels/js/permission-sessions.ts");

			const session = sessions.registerPermissionKernel(sessionId, { revoke: () => {}, retire: async () => {} });

			expect({ dead: session.dead, pending: session.pending }).toEqual({ dead: true, pending: undefined });
			// Nothing revives it: the view of a handle this copy cannot read offers no way back either.
			session.dead = false;
			expect(session.dead).toBe(true);
		},
	);

	it("reads a session whose handle it can read as that handle reports it", async () => {
		const sessions = await import("../src/kernels/js/permission-sessions.ts");

		const session = sessions.registerPermissionKernel("x12965-readable", {
			revoke: () => {},
			retire: async () => {},
		});

		expect({ dead: session.dead, pending: session.pending }).toEqual({ dead: false, pending: undefined });
	});

	it("refuses a cross-session kernel tool when the invoker's snapshots cannot be read", async () => {
		const authority = await import("../src/kernels/shared/invocation-authority.ts");

		const invoke = () =>
			authority.invocationSession(
				"x12965-owner",
				{ cwd: "/owner", state: { epoch: 0, active: false, rules: [] } },
				{ invoker: { sessionId: "x12965-invoker" } },
			);

		expect(invoke).toThrow("Cross-session kernel tool refused: permission authority unavailable");
	});

	it("still serves the owner's own session without reading another session's state", async () => {
		const authority = await import("../src/kernels/shared/invocation-authority.ts");
		const owner = { cwd: "/owner", state: { epoch: 0, active: false, rules: [] } };

		expect(authority.invocationSession("x12965-owner", owner, { invoker: { sessionId: "x12965-owner" } })).toEqual({
			sessionId: "x12965-owner",
			...owner,
		});
	});
});
