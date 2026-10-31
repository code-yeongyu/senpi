import { basename } from "node:path";
import { expect } from "vitest";
import { hostInstanceId } from "../../../src/modes/rpc/protocol-identity.ts";
import type { ConstructionHost, Opened } from "./4272-construction-host-support.ts";

// Part of #4272 (S07b, RULING-52): every supported host/worker construction path of a lane-owned session, driven
// through the production router and registry, so the zero-retention and no-read assertions run on each of them.

/** The session the registry now lists for `sessionPath` (a parked reopen replies to nobody). */
async function listed(host: ConstructionHost, via: string, sessionPath: string): Promise<string> {
	const data = (await host.request(via, { type: "list_sessions" })).data as {
		sessions: Array<{ sessionId: string; sessionPath?: string }>;
	};
	const row = data.sessions.find((candidate) => basename(candidate.sessionPath ?? "") === basename(sessionPath));
	if (!row) throw new Error(`no listed session for ${sessionPath}: ${JSON.stringify(data.sessions)}`);
	return row.sessionId;
}

async function reclaim(host: ConstructionHost, via: string, opened: Opened): Promise<void> {
	const response = await host.request(via, {
		type: "reclaim_session",
		sessionPath: opened.sessionPath,
		durableSessionId: opened.durableSessionId,
		expectedHostInstance: hostInstanceId(),
	});
	expect(response.success, JSON.stringify(response)).toBe(true);
}

/**
 * Every supported way a lane-owned session comes to exist or gain a holder on a host, each ending with a turn on
 * the session it produced.
 */
export const CONSTRUCTION_PATHS: ReadonlyArray<readonly [string, (host: ConstructionHost) => Promise<void>]> = [
	[
		"open_session from a connection (router open -> registry open -> binding registers the lane)",
		async (host) => {
			host.connect("a");
			const opened = await host.open("a");
			await host.turn(opened.sessionId, "a");
		},
	],
	[
		"open_session with no requesting connection (the stdio host's open)",
		async (host) => {
			const opened = await host.open(undefined);
			await host.turn(opened.sessionId, undefined);
		},
	],
	[
		"a second open_session of the live session's path (registry attach to the live entry)",
		async (host) => {
			host.connect("a");
			host.connect("b");
			const opened = await host.open("a");
			const again = await host.open("b", { sessionPath: opened.sessionPath });
			expect(again).toMatchObject({ sessionId: opened.sessionId, attached: true });
			await host.turn(opened.sessionId, "b");
		},
	],
	[
		"attach_session by another connection",
		async (host) => {
			host.connect("a");
			host.connect("b");
			const opened = await host.open("a");
			const attached = await host.request("b", {
				type: "attach_session",
				sessionId: opened.sessionId,
				durableSessionId: opened.durableSessionId,
			});
			expect(attached.success, JSON.stringify(attached)).toBe(true);
			await host.turn(opened.sessionId, "b");
		},
	],
	[
		"reclaim_session, then open_session of the same path (a new entry and lane)",
		async (host) => {
			host.connect("a");
			const opened = await host.open("a");
			await host.turn(opened.sessionId, "a");
			await reclaim(host, "a", opened);
			const reopened = await host.open("a", { sessionPath: opened.sessionPath });
			expect(reopened.attached).toBe(false);
			await host.turn(reopened.sessionId, "a");
		},
	],
	[
		"successor reopen of a handoff-parked session (router.reopenParked)",
		async (host) => {
			host.connect("a");
			const opened = await host.open("a");
			await host.turn(opened.sessionId, "a");
			await reclaim(host, "a", opened);
			expect(await host.reopenParked({ sessionPath: opened.sessionPath, retainOnDisconnect: true })).toBeUndefined();
			await host.turn(await listed(host, "a", opened.sessionPath), "a");
		},
	],
	[
		"replacement: new_session re-bootstraps the session's lane",
		async (host) => {
			host.connect("a");
			const opened = await host.open("a");
			await host.turn(opened.sessionId, "a");
			const replaced = await host.request("a", { type: "new_session", sessionId: opened.sessionId });
			expect(replaced.success, JSON.stringify(replaced)).toBe(true);
			await host.turn(opened.sessionId, "a");
		},
	],
];
