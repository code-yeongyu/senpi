import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { dataOf, statusHost } from "../../../test/suite/rpc-session-status-support.ts";
import { ConnectionQuestionBridge } from "./connection-question-bridge.ts";
import { SessionEventWriter } from "./session-event-writer.ts";
import { ClientOccupancy } from "./host-client-occupancy.ts";

/**
 * An AbortController that also aborts when its `using` scope exits: a failed assertion then cancels the
 * test's dialog before the rig closes, instead of the close rejecting a dialog promise nobody awaits.
 */
function abortOnExit() {
	const controller = new AbortController();
	return Object.assign(controller, { [Symbol.dispose]: () => controller.abort() });
}

async function prepared() {
	const rig = await statusHost();
	const owner = rig.client("owner");
	const opened = dataOf(await owner.request({ type: "open_session", cwd: rig.cwd, retain_on_disconnect: true }));
	const sessionId = String(opened.sessionId);
	const captured: { ui?: ExtensionUIContext } = {};
	const api = [...rig.extensionApis.values()][0];
	if (!api) throw new Error("missing extension API");
	api.registerCommand("prepare-dialog", {
		description: "fixture",
		handler: async (_args, ctx) => {
			captured.ui = ctx.ui;
		},
	});
	await owner.request({ type: "prompt", sessionId, message: "/prepare-dialog" });
	const ui = captured.ui;
	if (!ui) throw new Error("missing UI context");
	const observer = rig.client("observer");
	await observer.request({ type: "subscribe_sessions", mirror: "all", dialogs: true, observe: true });
	return { rig, owner, observer, sessionId, ui };
}

// #4266: a session-owned dialog feed survives the command connection.
it("dialog raised after snapshot reaches the observer after its command connection closed", async () => {
	const { rig, owner, observer, sessionId, ui } = await prepared();
	await using _rig = rig;
	const snapshot = dataOf(await observer.request({ type: "get_snapshot", sessionId, observe: true }));
	await rig.drop(owner.name);
	using cancel = abortOnExit();
	const pending = observer.waitFor((r) => r.type === "ui_request_pending");
	const dialog = ui.confirm("Confirm", "Proceed?", { signal: cancel.signal });
	const raised = await pending;
	expect(raised).toMatchObject({ sessionId, method: "confirm", request: { method: "confirm" } });
	const markerIndex = observer.inbox.findIndex(
		(r) => r.type === "snapshot_marker" && r.markerId === snapshot.markerId,
	);
	expect(observer.inbox.indexOf(raised)).toBeGreaterThan(markerIndex);
	const answerer = rig.client("answerer");
	await answerer.request({ type: "set_client_info", width: 80, capabilities: ["interactive_user"] });
	await answerer.request({
		type: "open_session",
		sessionPath: dataOf(await observer.request({ type: "get_state", sessionId })).sessionFile,
	});
	const settled = observer.waitFor((r) => r.type === "ui_request_settled");
	expect(
		await answerer.request({
			type: "extension_ui_response",
			sessionId,
			uiRequestId: raised.uiRequestId,
			answerId: "answer",
			confirmed: true,
		}),
	).toMatchObject({ success: true, disposition: "applied" });
	expect(await dialog).toBe(true);
	expect(await settled).toMatchObject({ uiRequestId: raised.uiRequestId, disposition: "answered" });
	expect(observer.inbox.some((r) => r.type === "response" && r.command === "extension_ui_response")).toBe(false);
	const state = dataOf(await observer.request({ type: "get_state", sessionId }));
	expect(state.answeredUiRequests).toContainEqual({ uiRequestId: raised.uiRequestId, answerId: "answer" });
});

it("select record itself still has zero mirror recipients", async () => {
	const { rig, observer, sessionId, ui } = await prepared();
	await using _rig = rig;
	const pending = observer.waitFor((r) => r.type === "ui_request_pending");
	using cancel = abortOnExit();
	const dialog = ui.select("Pick", ["a"], { signal: cancel.signal });
	await pending;
	await observer.request({ type: "get_state", sessionId });
	expect(observer.inbox.some((r) => r.type === "extension_ui_request" && r.method === "select")).toBe(false);
	cancel.abort();
	await dialog;
});

it("includes an already pending dialog in the snapshot without emitting it again", async () => {
	const { rig, observer, sessionId, ui } = await prepared();
	await using _rig = rig;
	using cancel = abortOnExit();
	const dialog = ui.confirm("Confirm", "Proceed?", { signal: cancel.signal });
	const snapshot = dataOf(await observer.request({ type: "get_snapshot", sessionId }));
	expect(snapshot.state).toMatchObject({ pendingDialogs: [{ method: "confirm" }] });
	const markerIndex = observer.inbox.findIndex(
		(r) => r.type === "snapshot_marker" && r.markerId === snapshot.markerId,
	);
	expect(markerIndex).toBeGreaterThanOrEqual(0);
	expect(observer.inbox.slice(markerIndex + 1).some((r) => r.type === "ui_request_pending")).toBe(false);
	cancel.abort();
	await dialog;
});

it("keeps a dialogs observer and snapshot reader out of attachedCount", () => {
	const occupancy = new ClientOccupancy(() => {});
	const socket = new PassThrough();
	occupancy.admit(socket);
	socket.emit(
		"data",
		Buffer.from(JSON.stringify({ type: "subscribe_sessions", mirror: "all", dialogs: true, observe: true }) + "\n"),
	);
	socket.emit("data", Buffer.from(JSON.stringify({ type: "get_snapshot", sessionId: "s", observe: true }) + "\n"));
	expect(occupancy.attachedCount).toBe(0);
});

it("requires both dialogs and a matching mirrored subscription", async () => {
	const writer = new SessionEventWriter(() => {});
	const received = new Map<string, unknown[]>();
	writer.status.setSource({
		sessionIds: () => ["s"],
		entryView: () => ({ state: "open", kind: "interactive", cwd: "/test", attachments: 0, context: {} }),
		view: () => undefined,
	});
	for (const [id, mirror, dialogs, session] of [
		["yes", "all", true, "s"],
		["status", "none", true, "s"],
		["content", "all", false, "s"],
		["other", "all", true, "other"],
	] as const) {
		const records: unknown[] = [];
		received.set(id, records);
		writer.registerConnection(id, {
			writeRaw: (line) => {
				records.push(JSON.parse(line));
			},
			waitForBackpressure: async () => {},
		});
		const sub = writer.status.subscribe(id, {
			selector: { kind: "ids", ids: new Set([session]) },
			mirror: { kind: mirror },
			dialogs,
			includeWorkers: false,
			includeContext: false,
			effects: false,
		});
		writer.status.activate(sub.subscriptionId);
	}
	writer.enqueue("s", { type: "ui_request_settled", uiRequestId: "d", disposition: "cancelled" });
	await writer.flush();
	expect(received.get("yes")).toEqual([
		{ type: "ui_request_settled", sessionId: "s", uiRequestId: "d", disposition: "cancelled" },
	]);
	for (const id of ["status", "content", "other"]) expect(received.get(id)).toEqual([]);
});

it("observes question registration and cancellation without a correlated reply", async () => {
	const changes: unknown[] = [];
	const bridge = new ConnectionQuestionBridge(
		() => {},
		(change) => changes.push(change),
	);
	const question = bridge.ask({
		requestId: "q",
		waitForAnswer: true,
		timeoutMs: 60000,
		questions: [
			{ id: "q1", header: "Choice", question: "Continue?", options: [{ label: "Yes" }], multiSelect: false },
		],
	});
	const frame = bridge.pendingQuestions()[0];
	if (!frame) throw new Error("missing question");
	bridge.cancelAll();
	await question;
	expect(changes).toEqual([
		{
			type: "ui_request_pending",
			uiRequestId: frame.id,
			method: "question",
			request: expect.objectContaining({ id: frame.id, method: "question" }),
		},
		{ type: "ui_request_settled", uiRequestId: frame.id, disposition: "cancelled" },
	]);
});

// #4266: the stdio lane cannot subscribe (session-status-commands.ts), so opt-in observation records never reach it.
it("keeps observation records off the stdio lane", async () => {
	const stdio: string[] = [];
	const writer = new SessionEventWriter((line) => {
		stdio.push(line);
	});
	const request = { type: "extension_ui_request", id: "d", method: "confirm", title: "Confirm", message: "Proceed?" };
	writer.enqueue("s", { type: "snapshot_marker", markerId: "m" });
	writer.enqueue("s", { type: "ui_request_pending", uiRequestId: "d", method: "confirm", request });
	writer.enqueue("s", { type: "ui_request_settled", uiRequestId: "d", disposition: "cancelled" });
	// Positive control: an ordinary session record still reaches the stdio lane.
	writer.enqueue("s", { type: "agent_start" });
	await writer.flush();
	expect(stdio.map((line) => JSON.parse(line).type)).toEqual(["agent_start"]);
});
