import { expect, it } from "vitest";
import type { RpcSessionEntry, RpcSessionRow, RpcSessionState } from "../../src/modes/rpc/session-registry-types.ts";
import type { RouterContext } from "../../src/modes/rpc/session-router-context.ts";
import { validatedOpenProfile } from "../../src/modes/rpc/session-router-open-profile.ts";

// senpi#4381: a task child inherits its parent's caller env exactly when attach_session would accept that parent
// (open and bound on this host); a closing, quarantined or unbound parent contributes nothing.
const PARENT = "s-parent";

function hostWithParent(state: RpcSessionState, bound: boolean): RouterContext {
	const entry = { state, profile: { cwd: "/work", sessionEnv: { OMOCAT_LANE: "lane-parent" } } };
	const row = { sessionId: PARENT, durableSessionId: "d-parent" };
	return {
		defaults: { cwd: "/work" },
		registry: {
			list: () => [row as RpcSessionRow],
			peek: (handle: string) => (handle === PARENT ? (entry as unknown as RpcSessionEntry) : undefined),
		},
		bindings: new Map(bound ? [[PARENT, {}]] : []),
	} as unknown as RouterContext;
}

function childEnv(host: RouterContext, parentSessionId: string): unknown {
	const profile = validatedOpenProfile(host, {
		type: "open_session",
		spawnedBy: { parentSessionId, rootSessionId: parentSessionId, taskId: "t-1" },
	});
	return "sessionEnv" in profile ? profile.sessionEnv : undefined;
}

it.each([
	["s-parent", "routing id"],
	["d-parent", "durable id"],
])("gives a child the env of an open, bound parent named by its %s", (parentSessionId) => {
	expect(childEnv(hostWithParent("open", true), parentSessionId)).toEqual({ OMOCAT_LANE: "lane-parent" });
});

it.each([
	["closing", true],
	["quarantined", true],
	["opening", true],
	["open", false],
] as const)("gives a child no env from a parent that is %s (bound: %s), which attach would refuse", (state, bound) => {
	expect(childEnv(hostWithParent(state, bound), PARENT)).toBeUndefined();
});
