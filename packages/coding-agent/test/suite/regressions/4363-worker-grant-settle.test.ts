// #4363: a worker session's grant stays guarded until the worker reports it settled.
import { expect, it } from "vitest";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { SessionWorkerClient } from "../../../src/modes/rpc/session-worker-client.ts";

const sessionId = "synthetic-worker-session";
const grantId = "synthetic-grant-request";

async function setup() {
	const writer = new SessionEventWriter(() => {});
	for (const [id, capabilities] of [
		["grant-client", ["grant_select"]],
		["grant-other", ["grant_select"]],
	] as const) {
		writer.registerConnection(id, { writeRaw: () => {}, waitForBackpressure: async () => {} });
		writer.setConnectionCapabilities(id, [...capabilities]);
		writer.attachConnectionToSession(id, sessionId);
	}
	let cancelled = 0;
	const route = writer.routeWorkerGrant(sessionId, grantId, "grant-client", [], () => {
		cancelled += 1;
	});
	expect(route).toEqual({ accepted: true, connection: "grant-client" });
	const forwarded: unknown[] = [];
	// Only the binding's command gate is under test; the worker thread itself is not started, so a
	// forwarded answer stays unsettled until the test reports security_grant_settled itself.
	const client = {
		request: async (message: { type: string; command?: unknown }) => {
			if (message.type === "command") forwarded.push(message.command);
			return { type: "result" };
		},
		post: () => {},
	} as unknown as SessionWorkerClient;
	const binding = await SessionWorkerClient.prototype.bind.call(client, sessionId, writer, () => {}, {});
	const answer = (connection: string, frame: Record<string, unknown>) =>
		writer.withConnection(connection, () =>
			binding.handle({ type: "extension_ui_response", value: "Grant and save permanently", ...frame }),
		);
	return { writer, forwarded, answer, cancelled: () => cancelled };
}

it("keeps the grant guarded after the recipient's answer until the worker settles it", async () => {
	const { forwarded, answer } = await setup();
	// The worker may refuse this frame (for example an out-of-range answer) and leave the grant pending.
	await answer("grant-client", { id: grantId, answerId: 99 });
	expect(forwarded).toHaveLength(1);
	await answer("grant-other", { id: "synthetic-answer-b", uiRequestId: grantId });
	await answer("grant-other", { id: grantId });
	expect(forwarded).toHaveLength(1);
	await answer("grant-client", { id: grantId });
	expect(forwarded).toHaveLength(2);
});

it("drops the guard entry once the worker reports the grant settled", async () => {
	const { writer, forwarded, answer } = await setup();
	await answer("grant-client", { id: grantId });
	expect(forwarded).toHaveLength(1);
	expect(writer.acceptWorkerGrantResponse(sessionId, grantId, "grant-client")).toBe(true);
	writer.settleGrantDialog(sessionId, grantId);
	expect(writer.acceptWorkerGrantResponse(sessionId, grantId, "grant-client")).toBeUndefined();
});

it("cancels and drops the guard entry when the recipient detaches", async () => {
	const { writer, cancelled } = await setup();
	writer.detachConnectionFromSession("grant-client", sessionId);
	expect(cancelled()).toBe(1);
	expect(writer.acceptWorkerGrantResponse(sessionId, grantId, "grant-client")).toBeUndefined();
});
