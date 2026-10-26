// #4348: a worker session's grant answer is matched by the request it answers (uiRequestId ?? id).
import { expect, it } from "vitest";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { SessionWorkerClient } from "../../../src/modes/rpc/session-worker-client.ts";

const sessionId = "synthetic-worker-session";
const grantId = "synthetic-grant-request";

async function setup() {
	const writer = new SessionEventWriter(() => {});
	for (const [id, capabilities] of [
		["question-only", ["question"]],
		["grant-client", ["grant_select"]],
		["grant-other", ["grant_select"]],
	] as const) {
		writer.registerConnection(id, { writeRaw: () => {}, waitForBackpressure: async () => {} });
		writer.setConnectionCapabilities(id, [...capabilities]);
		writer.attachConnectionToSession(id, sessionId);
	}
	const route = writer.routeWorkerGrant(sessionId, grantId, "grant-client", [], () => {});
	expect(route).toEqual({ accepted: true, connection: "grant-client" });
	const forwarded: unknown[] = [];
	// Only the binding's command gate is under test; the worker thread itself is not started.
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
	return { forwarded, answer };
}

it("does not forward a long-form grant answer from a connection without grant_select", async () => {
	const { forwarded, answer } = await setup();
	await answer("question-only", { id: "synthetic-answer-a", uiRequestId: grantId });
	expect(forwarded).toHaveLength(0);
	await answer("grant-client", { id: grantId });
	expect(forwarded).toHaveLength(1);
});

it("does not forward a long-form grant answer from another grant_select connection", async () => {
	const { forwarded, answer } = await setup();
	await answer("grant-other", { id: "synthetic-answer-b", uiRequestId: grantId });
	expect(forwarded).toHaveLength(0);
	await answer("grant-client", { id: grantId });
	expect(forwarded).toHaveLength(1);
});

it("forwards the short-form answer of the grant recipient", async () => {
	const { forwarded, answer } = await setup();
	await answer("grant-client", { id: grantId });
	expect(forwarded).toHaveLength(1);
});

it("forwards the long-form answer of the grant recipient", async () => {
	const { forwarded, answer } = await setup();
	await answer("grant-client", { id: "synthetic-answer-d", uiRequestId: grantId });
	expect(forwarded).toHaveLength(1);
});
