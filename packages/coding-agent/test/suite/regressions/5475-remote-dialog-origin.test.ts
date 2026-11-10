// #5475: a dialog raised by the command of a connection that declared a remote origin carries that origin as
// `remoteOrigin`, on the targeted frame and on the mirrored `ui_request_pending`; a local connection's dialog carries
// none. The relay forwarder is the only writer: it declares the origin once through its own `set_client_info`, and a
// later, different value is refused so the label cannot be swapped under a pending dialog. Protocol contract
// consumed by the desktop and TUI "Requested from <device>" label (omo-relay-daemon#184 P5/P6).
import { expect, it } from "vitest";
import { ConnectionQuestionBridge } from "../../../src/modes/rpc/connection-question-bridge.ts";
import { dataOf, type RawClient, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

const ORIGIN = { deviceId: "device-a", deviceName: "Laptop" };

async function prepared() {
	const rig = await statusHost();
	const owner = rig.client("owner");
	const remote = rig.client("remote");
	const observer = rig.client("observer");
	const opened = dataOf(await owner.request({ type: "open_session", cwd: rig.cwd, retain_on_disconnect: true }));
	const sessionId = String(opened.sessionId);
	const durableSessionId = (opened.state as { sessionId: string }).sessionId;
	const cancel = new AbortController();
	const api = [...rig.extensionApis.values()][0];
	if (!api) throw new Error("missing extension API");
	api.registerCommand("raise", {
		description: "fixture: raise a confirm and a select during this command's dispatch",
		handler: async (_args, ctx) => {
			void ctx.ui.confirm("Confirm", "Proceed?", { signal: cancel.signal });
			void ctx.ui.select("Pick", ["a"], { signal: cancel.signal });
		},
	});
	await observer.request({ type: "subscribe_sessions", mirror: "all", dialogs: true, observe: true });
	return { rig, owner, remote, observer, sessionId, durableSessionId, cancel };
}

const raisedTo = (client: RawClient, method: string): Promise<WireRecord> =>
	client.waitFor((r) => r.type === "extension_ui_request" && r.method === method);
const mirrored = (observer: RawClient, method: string, from: number): Promise<WireRecord> =>
	observer.waitFor((r) => r.type === "ui_request_pending" && r.method === method && observer.inbox.indexOf(r) >= from);

it("labels a remote connection's dialogs with its declared origin, on the frame and on the mirror", async () => {
	const { rig, remote, observer, sessionId, durableSessionId, cancel } = await prepared();
	await using _rig = rig;
	expect(await remote.request({ type: "set_client_info", width: 80, remoteOrigin: ORIGIN })).toMatchObject({
		success: true,
	});
	expect(await remote.request({ type: "attach_session", sessionId, durableSessionId })).toMatchObject({
		success: true,
	});
	const from = observer.inbox.length;
	await remote.request({ type: "prompt", sessionId, message: "/raise" });
	for (const method of ["confirm", "select"]) {
		expect((await raisedTo(remote, method)).remoteOrigin).toEqual(ORIGIN);
		expect(((await mirrored(observer, method, from)).request as WireRecord).remoteOrigin).toEqual(ORIGIN);
	}
	cancel.abort();
});

it("leaves a local connection's dialogs unlabeled", async () => {
	const { rig, owner, observer, sessionId, cancel } = await prepared();
	await using _rig = rig;
	const from = observer.inbox.length;
	await owner.request({ type: "prompt", sessionId, message: "/raise" });
	for (const method of ["confirm", "select"]) {
		expect(await raisedTo(owner, method)).not.toHaveProperty("remoteOrigin");
		expect((await mirrored(observer, method, from)).request).not.toHaveProperty("remoteOrigin");
	}
	cancel.abort();
});

it("carries a host-declared origin across IPC to a worker session's dialog", async () => {
	const host = await startWorkerHost(
		`export default function (pi) {
		pi.registerCommand("ask", { description: "test UI", handler: async (_args, ctx) => {
			await ctx.ui.confirm("test", "confirm");
		} });
	}`,
		{ socket: true },
	);
	try {
		const remote = await host.connect();
		const local = await host.connect();
		expect((await remote.request({ type: "set_client_info", width: 80, remoteOrigin: ORIGIN })).success).toBe(true);
		const opened = await local.request({ type: "open_session", cwd: host.cwd });
		const sessionId = opened.data?.sessionId;
		await remote.request({ type: "open_session", cwd: host.cwd, sessionPath: opened.data?.state?.sessionFile });
		for (const [client, expected] of [
			[remote, ORIGIN],
			[local, undefined],
		] as const) {
			const raised = client.wait((r) => r.type === "extension_ui_request" && r.method === "confirm");
			const prompt = client.request({ type: "prompt", sessionId, message: "/ask" });
			const frame = await raised;
			expect(frame.remoteOrigin).toEqual(expected);
			client.send({ type: "extension_ui_response", sessionId, id: frame.id, confirmed: true });
			expect((await prompt).success).toBe(true);
		}
	} finally {
		await host.dispose();
	}
}, 60_000);

it("fixes a connection's origin once declared and refuses a malformed one", async () => {
	const { rig, remote } = await prepared();
	await using _rig = rig;
	expect(await remote.request({ type: "set_client_info", width: 80, remoteOrigin: ORIGIN })).toMatchObject({
		success: true,
	});
	expect(await remote.request({ type: "set_client_info", width: 90, remoteOrigin: ORIGIN })).toMatchObject({
		success: true,
	});
	const changed = await remote.request({
		type: "set_client_info",
		width: 80,
		remoteOrigin: { deviceId: "device-b" },
	});
	expect(changed).toMatchObject({ success: false, error: expect.stringMatching(/^remote_origin_fixed/) });
	const fresh = rig.client("fresh");
	for (const remoteOrigin of [{ deviceId: "" }, { deviceId: "d", extra: 1 }, "device-a", { deviceName: "x" }]) {
		expect(await fresh.request({ type: "set_client_info", width: 80, remoteOrigin })).toMatchObject({
			success: false,
			error: expect.stringMatching(/^remote_origin_invalid/),
		});
	}
});

it("carries the raising connection's origin on a question frame, next to raisedBy", () => {
	const frames: WireRecord[] = [];
	const remoteBridge = new ConnectionQuestionBridge(
		(record) => frames.push(record as WireRecord),
		undefined,
		() => "remote",
		() => ORIGIN,
	);
	const localBridge = new ConnectionQuestionBridge((record) => frames.push(record as WireRecord));
	const cancel = new AbortController();
	const question = {
		requestId: "q",
		waitForAnswer: true,
		timeoutMs: 60_000,
		questions: [{ id: "q1", header: "h", question: "?", options: [{ label: "A" }], multiSelect: false }],
	};
	void remoteBridge.ask(question, { signal: cancel.signal });
	void localBridge.ask(question, { signal: cancel.signal });
	expect(frames[0]).toMatchObject({ raisedBy: "remote", remoteOrigin: ORIGIN });
	expect(frames[1]).toMatchObject({ raisedBy: "agent" });
	expect(frames[1]).not.toHaveProperty("remoteOrigin");
	expect(remoteBridge.pendingQuestions()[0]).toMatchObject({ remoteOrigin: ORIGIN });
	cancel.abort();
});
