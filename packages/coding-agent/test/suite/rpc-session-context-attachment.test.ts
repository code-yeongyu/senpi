import { describe, expect, it } from "vitest";
import { dataOf, statusHost } from "./rpc-session-status-support.ts";

describe("set_session_context attachment refusal", () => {
	it("returns a dedicated code when a connected client has not attached", async () => {
		// Given: the owner has a session, but the observer has no attachment.
		await using rig = await statusHost();
		const owner = rig.client("owner");
		const observer = rig.client("observer");
		const opened = dataOf(await owner.request({ type: "open_session", cwd: rig.cwd }));

		// When: the observer tries to patch the owner's context.
		const refused = await observer.request({
			type: "set_session_context",
			sessionId: opened.sessionId,
			patch: { task_status: "running" },
		});

		// Then: the error identifies the missing attachment and gives a recovery action.
		expect(refused).toMatchObject({
			success: false,
			errorCode: "session_not_attached",
			errorData: {
				reason: "this connection is not attached to that session",
				action: "attach first with open_session { sessionPath }, then patch its context",
			},
		});
	});
});
