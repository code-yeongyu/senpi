/**
 * An accepted relocation end to end on a REAL in-process host: the agent asks mid-turn, the turn runs to its end,
 * `relocation_due` follows, and the host's ordinary `release_session` reason `move` plus `move_session export` end
 * this runtime cleanly with the move recorded under the session's own id. The client that asks for the release stays
 * attached and never needs `force`: only ANOTHER attached client refuses it.
 */
import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { afterReleased, nextEvent } from "./rpc-release-host-support.ts";
import { relocationHost } from "./rpc-relocate-session-host-support.ts";

describe("relocate_session success on a real host", () => {
	it("ends this runtime cleanly with the move recorded, released by its own attached client without force", async () => {
		// Given: the agent asked mid-turn and the turn ended; the desktop that asks for the release is attached.
		const { host, dueSeen, work, release, sessionId, sessionPath, session } = await relocationHost();
		await using _host = host;
		const durableId = session.sessionId;
		await work();
		const notice = await dueSeen;

		// When: that same client runs the existing move steps, with no force.
		const released = await release();
		const exported = await host.send({
			type: "move_session",
			id: "exp",
			op: "export",
			sessionPath,
			moveId: "mv-a1",
			target: "Studio",
		} as never);

		// Then: the due notice named the move; the release sealed it with nothing after; the export carries the id.
		expect(notice).toMatchObject({ sessionId, moveId: "mv-a1", target: "Studio" });
		expect(released).toMatchObject({ success: true, data: { released: true } });
		expect(afterReleased(sessionPath)).toEqual([]);
		const file = readFileSync(sessionPath, "utf8");
		expect(file).toContain("run the heavy build");
		expect(file).toContain("handing over to Studio");
		const seal = file
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { customType?: string; data?: Record<string, unknown> })
			.find((entry) => entry.customType === "session_released");
		expect(seal?.data).toMatchObject({ reason: "move", move_id: "mv-a1", target: "Studio", session_id: durableId });
		expect(exported).toMatchObject({ success: true, data: { move_id: "mv-a1", session_id: durableId } });
		expect(await host.send({ type: "get_state", id: "after", sessionId })).toMatchObject({
			success: false,
			error: expect.stringContaining("unknown_session"),
		});
	});

	it("refuses the release while ANOTHER client is attached; the session stays writable for it", async () => {
		// Given: the move is due, and a second client (another window) is attached to the same session.
		const { host, dueSeen, work, release, sessionId, sessionPath, session } = await relocationHost({
			otherClient: { name: "second-window" },
		});
		await using _host = host;
		await work();
		await dueSeen;

		// When: the desktop asks for the release, with no force.
		const refused = await release();

		// Then: refused `attached`, naming the one other client; nothing sealed; the second client still works here.
		expect(refused).toMatchObject({ success: false, error: "attached", errorData: { attachments: 1 } });
		expect(afterReleased(sessionPath)).toBeNull();
		host.faux.setResponses([fauxAssistantMessage("still on this computer")]);
		const settled = nextEvent(session, "agent_settled");
		expect(
			await host.send({ type: "prompt", id: "more", sessionId, message: "keep going here" }, "second-window"),
		).toMatchObject({ success: true });
		await settled;
		expect(readFileSync(sessionPath, "utf8")).toContain("still on this computer");
	});
});
