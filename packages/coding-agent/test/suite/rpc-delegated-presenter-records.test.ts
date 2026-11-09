/**
 * senpi#4249 R-1b (d1): on a delegated connection the four private presenter client records reach the presenter
 * authority when the declaration granted `answer`, and every outcome for any `mcp_form_*` / `mcp_presenter_*` type
 * is the private reply shape, written past the connection's event queue, never an ordinary `type: "response"`.
 * Security contract: a relay host routes a private-typed answer to its presenter tunnel, never to a command.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { type CorePeer, declare, startCore, type WireRecord } from "./rpc-delegated-presenter-support.ts";

let core: Awaited<ReturnType<typeof startCore>>;
beforeEach(async () => {
	core = await startCore();
	core.writer.bindMcpForms("session", "durable", {}, () => {});
});
afterEach(async () => {
	await core.dispose();
});

function attached(id: string, drain?: () => Promise<void>): CorePeer {
	const peer = core.peer(id, { launchProof: "proven", ...(drain === undefined ? {} : { drain }) });
	core.writer.attachConnectionToSession(id, "session");
	return peer;
}

async function privately(peer: CorePeer, record: WireRecord): Promise<WireRecord[]> {
	const id = String(record.id);
	const answered = peer.written((line) => line.id === id);
	await peer.send(record);
	await answered;
	return peer.answers(id);
}

it("on a delegated connection with answer, mcp_presenter_context reaches the presenter authority", async () => {
	const peer = attached("delegated");
	expect(await declare(peer, ["observe", "answer"])).toMatchObject({ success: true });
	const sender = core.writer.getMcpPresenterConnection("delegated");
	if (!sender) throw new Error("the presenter authority did not register the connection");
	expect(await privately(peer, { id: "context", type: "mcp_presenter_context", sessionId: "session" })).toEqual([
		{
			type: "mcp_form_reply",
			id: "context",
			ok: true,
			context: core.writer.mcpPresenters?.connectionContext(sender, "session"),
		},
	]);
});

it.each([
	["mcp_form_response without answer", ["observe"], "mcp_form_response", "delegation_not_granted"],
	["mcp_form_sync without answer", ["observe"], "mcp_form_sync", "delegation_not_granted"],
	["mcp_presenter_context without answer", ["observe"], "mcp_presenter_context", "delegation_not_granted"],
	["a private type the engine does not take", ["answer"], "mcp_form_resolved", "delegation_unclassified"],
	["a control-endpoint frame", ["answer"], "mcp_presenter_acquire", "delegation_unclassified"],
	["an invented presenter type", ["answer"], "mcp_presenter_x4249", "delegation_unclassified"],
])("%s is answered in the private reply shape and never type response", async (_name, granted, type, error) => {
	const peer = attached("delegated");
	expect(await declare(peer, granted)).toMatchObject({ success: true });
	expect(await privately(peer, { id: "private", type, sessionId: "session" })).toEqual([
		{ type: "mcp_form_reply", id: "private", error },
	]);
	expect(peer.lines.filter((line) => line.type === "response" && line.command === type)).toEqual([]);
});

it("a private record without an id is refused in the private shape without one", async () => {
	const peer = attached("delegated");
	expect(await declare(peer, ["observe"])).toMatchObject({ success: true });
	const refused = peer.written((line) => line.type === "mcp_form_reply" || line.command === "mcp_form_response");
	await peer.send({ type: "mcp_form_response", sessionId: "session" });
	expect(await refused).toEqual({ type: "mcp_form_reply", error: "delegation_not_granted" });
});

it("after a narrowing declaration that drops answer, the next private record gets the private refusal", async () => {
	const peer = attached("delegated");
	expect(await declare(peer, ["observe", "answer"])).toMatchObject({ success: true });
	expect(await privately(peer, { id: "before", type: "mcp_presenter_context", sessionId: "session" })).toEqual([
		expect.objectContaining({ type: "mcp_form_reply", ok: true }),
	]);
	expect(await declare(peer, ["observe"], "narrow")).toMatchObject({ success: true, data: { granted: ["observe"] } });
	expect(await privately(peer, { id: "after", type: "mcp_form_sync", sessionId: "session" })).toEqual([
		{ type: "mcp_form_reply", id: "after", error: "delegation_not_granted" },
	]);
});

it("the private refusal is written past the connection's event queue, while that queue is stalled", async () => {
	const stalled = Promise.withResolvers<void>();
	const peer = attached("delegated", () => stalled.promise);
	try {
		expect(await declare(peer, ["observe"])).toMatchObject({ success: true });
		await peer.send({ id: "queued", type: "get_protocol_info" });
		await peer.send({ id: "private", type: "mcp_form_response", sessionId: "session" });
		expect(peer.answers("private")).toEqual([
			{ type: "mcp_form_reply", id: "private", error: "delegation_not_granted" },
		]);
		expect(peer.answers("queued")).toEqual([]);
	} finally {
		stalled.resolve();
	}
});

it("a connection that never declared keeps today's private handling", async () => {
	const peer = attached("local");
	const sender = core.writer.getMcpPresenterConnection("local");
	if (!sender) throw new Error("the presenter authority did not register the connection");
	expect(await privately(peer, { id: "context", type: "mcp_presenter_context", sessionId: "session" })).toEqual([
		{
			type: "mcp_form_reply",
			id: "context",
			ok: true,
			context: core.writer.mcpPresenters?.connectionContext(sender, "session"),
		},
	]);
});
