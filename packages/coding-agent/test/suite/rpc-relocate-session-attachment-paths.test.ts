/**
 * Session relocation (senpi#3994) on the attachment commands this host adds (senpi#3795): a client that joins with
 * `attach_session` is asked like one that joined with `open_session`, and a client that leaves with
 * `release_attachment` or `reclaim_session` ends a request still waiting on it at once, as `close_session` does.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import relocateSessionExtension from "../../src/core/extensions/builtin/relocate-session/index.ts";
import { nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";
import { ACCEPT, DESKTOP, OFFERS, type WireRecord } from "./rpc-relocate-session-host-support.ts";

type Answer = (request: WireRecord, reply: (data: unknown) => void) => void;

async function relocatingSession(answer: Answer) {
	const received: Array<{ readonly connection: string | undefined; readonly record: WireRecord }> = [];
	let onRequest: (record: WireRecord) => void = () => {};
	const host = await startReleaseHost(relocateSessionExtension, {
		onRecord: (record, connection) => {
			received.push({ connection, record });
			if (record.type === "host_request") onRequest(record);
		},
	});
	onRequest = (record) =>
		answer(
			record,
			(data) =>
				void host.send(
					{ type: "host_response", id: String(record.id), sessionId: String(record.sessionId), data } as never,
					DESKTOP,
				),
		);
	host.faux.setResponses([
		fauxAssistantMessage("seed reply"),
		fauxAssistantMessage([fauxToolCall("relocate_session", { target: "Studio", reason: "heavy build" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("handing over to Studio"),
	]);
	const opened = await host.open("relocating");
	const requestsOn = (connection: string) =>
		received.filter((entry) => entry.connection === connection && entry.record.type === "host_request");
	const relocationResult = () =>
		opened.session.messages.findLast(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "relocate_session",
		)?.details;
	return { host, requestsOn, relocationResult, ...opened };
}

describe("relocation on the attachment commands", () => {
	it("asks a client that joined with attach_session", async () => {
		// Given: the session's opener is gone, and the desktop offers relocation and joins with attach_session.
		const { host, sessionId, session, requestsOn, relocationResult } = await relocatingSession((_request, reply) =>
			reply(ACCEPT),
		);
		await using _host = host;
		await host.send({ type: "set_client_info", id: "caps", width: 80, capabilities: [...OFFERS] }, DESKTOP);
		expect(
			await host.send(
				{ type: "attach_session", id: "join", sessionId, durableSessionId: session.sessionId } as never,
				DESKTOP,
			),
		).toMatchObject({ success: true });

		// When: the agent asks to move.
		const settled = nextEvent(session, "agent_settled");
		await host.send({ type: "prompt", id: "work", sessionId, message: "run the heavy build" }, DESKTOP);
		await settled;

		// Then: the desktop was asked, and the move was not answered "nobody offers it".
		expect(requestsOn(DESKTOP).map((entry) => entry.record.method)).toContain("relocate_session");
		expect(relocationResult()).not.toMatchObject({ status: "unavailable" });
	});

	it("fails a request waiting on a client that leaves with release_attachment at once", async () => {
		// Given: the desktop offers relocation and answers the request by releasing its attachment.
		const { host, sessionId, sessionPath, session, relocationResult } = await relocatingSession(
			(request) =>
				void host.send({ type: "release_attachment", id: "leave", sessionId: String(request.sessionId) }, DESKTOP),
		);
		await using _host = host;
		await host.attach(sessionPath, DESKTOP, OFFERS);

		// When: the agent asks to move.
		const settled = nextEvent(session, "agent_settled");
		await host.send({ type: "prompt", id: "work", sessionId, message: "run the heavy build" }, DESKTOP);
		await settled;

		// Then: the tool answered that the app left, well before the 60 s answer timeout.
		expect(relocationResult()).toMatchObject({ status: "refused", reason: "app_disconnected" });
	});

	it("fails a request waiting on a client that leaves with reclaim_session as the app leaving, not as a close", async () => {
		// Given: the desktop offers relocation and answers the request by reclaiming the session.
		let reclaimed: Promise<WireRecord> | undefined;
		const { host, sessionId, sessionPath, session, relocationResult } = await relocatingSession((_request) => {
			reclaimed = host.send(
				{
					type: "reclaim_session",
					id: "reclaim",
					sessionPath,
					durableSessionId: session.sessionId,
					expectedHostInstance: "release-test-host",
				} as never,
				DESKTOP,
			);
		});
		await using _host = host;
		await host.attach(sessionPath, DESKTOP, OFFERS);

		// When: the agent asks to move, and the desktop reclaims the session while it is asked.
		const settled = nextEvent(session, "agent_settled");
		await host.send({ type: "prompt", id: "work", sessionId, message: "run the heavy build" }, DESKTOP);
		await settled;

		// Then: the reclaim succeeded, and the request ended because the app left, before the session closed.
		expect(await reclaimed).toMatchObject({ success: true, data: { reclaimed: true } });
		expect(relocationResult()).toMatchObject({ status: "refused", reason: "app_disconnected" });
	});
});
