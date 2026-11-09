import { afterEach, describe, expect, it } from "vitest";
import { attach, type DelegatedHost, declare } from "../rpc-delegated-host-support.ts";
import {
	ASKED,
	FrameLog,
	open,
	PROBE_TEXT,
	permissionHost,
	probeCalls,
	remotePeer,
} from "../rpc-delegated-permission-support.ts";

// Remote approval-mode work (tracked privately): a remote turn's approval must outlive the connection that raised it,
// and only a device holding `answer` may settle it.

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

describe("#6189 pending approvals of remote turns", () => {
	it("keeps a remote turn's approval pending after its connection drops, for an answer-holding device to settle", async () => {
		host = await permissionHost();
		const raiser = await remotePeer(host);
		const raiserLog = new FrameLog(raiser);
		const session = await open(raiser);
		const raised = raiserLog.next(
			(record) =>
				record.type === "extension_ui_request" &&
				record.method === "select" &&
				record.sessionId === session.sessionId,
		);
		await raiser.send({ type: "prompt", sessionId: session.sessionId, message: "go" });
		const dialog = await raised;
		await host.drop(raiser);

		const other = await host.proven();
		expect(
			await declare(other, ["observe", "drive", "thread", "answer"], {
				deviceId: "x6189-other",
				deviceName: "Other",
			}),
		).toMatchObject({ success: true });
		const otherLog = new FrameLog(other);
		expect(await other.send(attach(session))).toMatchObject({ success: true });
		const state = await other.send({ type: "get_state", sessionId: session.sessionId });
		const pending = (state.data as { pendingDialogs?: Array<{ id: unknown }> }).pendingDialogs ?? [];
		expect(pending.map((entry) => entry.id)).toContain(dialog.id);

		const viewer = await host.proven();
		expect(
			await declare(viewer, ["observe", "thread"], { deviceId: "x6189-viewer", deviceName: "Viewer" }),
		).toMatchObject({ success: true });
		expect(await viewer.send(attach(session))).toMatchObject({ success: true });
		expect(
			await viewer.send({
				type: "extension_ui_response",
				sessionId: session.sessionId,
				id: dialog.id,
				value: "Allow once",
			}),
		).toMatchObject({ success: false, errorCode: "delegation_not_granted" });

		const ended = otherLog.next(
			(record) => record.type === "tool_execution_end" && record.sessionId === session.sessionId,
		);
		other.socket.write(
			`${JSON.stringify({ type: "extension_ui_response", sessionId: session.sessionId, id: dialog.id, value: "Deny" })}\n`,
		);
		expect(JSON.stringify(await ended)).not.toContain(PROBE_TEXT);
	}, 120_000);

	it("asks for a remote prompt on a worker-runtime session", async () => {
		host = await permissionHost([], { workers: true });
		const remote = await remotePeer(host);
		const log = new FrameLog(remote);
		const { sessionId } = await open(remote, { provider: "fauxsock", modelId: "faux-1" });
		const [call] = await probeCalls(log, { log, peer: remote }, sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "prompt", sessionId, message: "go" }),
		});
		expect(call).toEqual({ asked: ASKED, ran: false });
	}, 120_000);
});
