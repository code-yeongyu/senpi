/**
 * senpi#5889: a client branches on a refusal's code, never its text. A write into a session file that was moved away
 * or sealed (`move_session revoke`, #4004) must answer `errorCode: "session_moved_away"` with the ownership state, so a
 * client can render the session read-only and offer a copy.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SESSION_MOVED } from "../../../src/core/session-move/ownership.ts";
import { gatewayFixture } from "../rpc-release-gateway-fixture.ts";
import { startReleaseHost } from "../rpc-release-host-support.ts";

describe("a write into a sealed session (senpi#5889)", () => {
	it.each(["prompt", "follow_up", "steer"] as const)(
		"#given a hosted session sealed by a move #when %s is sent #then it is refused with session_moved_away and nothing is written",
		async (type) => {
			// Given: a hosted session whose file gained the `session_moved` entry a revoke appends.
			await using host = await startReleaseHost(gatewayFixture().extension);
			const { sessionId, sessionPath, session } = await host.open(`sealed-${type}`);
			session.sessionManager.appendCustomEntry(SESSION_MOVED, {
				move_id: "move-5889",
				target: "",
				reason: "revoked",
				moved_at: "2026-11-05T00:00:00.000Z",
			});
			const before = readFileSync(sessionPath, "utf8");

			// When: a client writes to it.
			const reply = await host.send({ type, id: `write-${type}`, sessionId, message: "typed after the seal" });

			// Then: the refusal is typed, names the ownership state, and the file is untouched.
			expect(reply).toMatchObject({
				type: "response",
				command: type,
				success: false,
				errorCode: "session_moved_away",
				errorData: { state: "moved" },
			});
			expect(readFileSync(sessionPath, "utf8")).toBe(before);
		},
	);
});
