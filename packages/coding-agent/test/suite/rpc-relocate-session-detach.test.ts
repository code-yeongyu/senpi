/**
 * The offering connection leaving the session ends what it was offering: on a REAL in-process host, a client that
 * detaches (`close_session`, its socket still open) gets no `relocation_due` for a move it accepted, and a request
 * still waiting on it fails at once instead of after the 60 s answer timeout.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { nextEvent } from "./rpc-release-host-support.ts";
import { DESKTOP, relocationHost } from "./rpc-relocate-session-host-support.ts";

function heldClosing(): { readonly step: FauxResponseStep; readonly release: () => void } {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const step: FauxResponseStep = async () => {
		await gate;
		return fauxAssistantMessage("handing over to Studio");
	};
	return { step, release };
}

describe("the offering connection detaching from the session", () => {
	it("drops a move it accepted: after close_session, the settled run sends no relocation_due", async () => {
		// Given: the desktop accepted the move, the turn is still running, and an older client stays attached.
		const closing = heldClosing();
		const { host, work, recordsOn, sessionId, session } = await relocationHost({
			otherClient: { name: "older-client" },
			closing: closing.step,
		});
		await using _host = host;
		const toolDone = nextEvent(session, "tool_execution_end");
		await work();
		await toolDone;

		// When: the desktop detaches, then the run ends, then a later turn here settles as well.
		expect(await host.send({ type: "close_session", id: "bye", sessionId }, DESKTOP)).toMatchObject({
			success: true,
		});
		const settled = nextEvent(session, "agent_settled");
		closing.release();
		await settled;
		host.faux.setResponses([fauxAssistantMessage("still here")]);
		const later = nextEvent(session, "agent_settled");
		await host.send({ type: "prompt", id: "later", sessionId, message: "keep going" }, "older-client");
		await later;

		// Then: nobody is told to move the session.
		expect(recordsOn(DESKTOP, "relocation_due")).toEqual([]);
		expect(recordsOn("older-client", "relocation_due")).toEqual([]);
	});

	it("fails a request still waiting on the connection at once, not after the answer timeout", async () => {
		// Given: the desktop never answers; it detaches as soon as it is asked.
		const { host, work, session } = await relocationHost({
			answer: (request) =>
				void host.send({ type: "close_session", id: "bye", sessionId: String(request.sessionId) }, DESKTOP),
		});
		await using _host = host;
		const settled = nextEvent(session, "agent_settled");

		// When: the agent asks to move.
		await work();
		await settled;

		// Then: the tool answered a typed refusal well inside the test's own deadline; the session stays here.
		const result = session.messages.findLast(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "relocate_session",
		);
		expect(result?.details).toMatchObject({ status: "refused", reason: "app_disconnected" });
	});
});
