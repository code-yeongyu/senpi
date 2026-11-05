import { afterEach, describe, expect, it } from "vitest";
import { attachmentRig } from "./rpc-attachment-support.ts";
import { attachmentWireResponse } from "./rpc-attachment-wire-schema.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

const requireAttach = process.env.SENPI_RPC_REQUIRE_ATTACH;
afterEach(() => {
	if (requireAttach === undefined) delete process.env.SENPI_RPC_REQUIRE_ATTACH;
	else process.env.SENPI_RPC_REQUIRE_ATTACH = requireAttach;
});

// senpi#3814 review H1: every hold the caller owns is its own, however many it opened.
// unload_session is in-process only; a worker isolate answers it as unsupported.
describe("unload counts only other connections", () => {
	const sessionRuntime = "in-process";
	it("unloads a session whose only attachments are the caller's two holds", async () => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const caller = await host.connect();
			const opened = await caller.request({ type: "open_session", cwd: host.cwd, retain_on_disconnect: true });
			const sessionId = opened.data?.sessionId;
			const sessionPath = opened.data?.state?.sessionFile;
			expect(
				await caller.request({ type: "open_session", cwd: host.cwd, sessionPath, attended: false }),
			).toMatchObject({ success: true, data: { sessionId, attached: true } });
			expect((await caller.request({ type: "list_sessions" })).data?.sessions).toEqual([
				expect.objectContaining({ sessionId, attachments: 2 }),
			]);
			const unloaded = await caller.request({ type: "unload_session", sessionId });
			expect(unloaded, JSON.stringify(unloaded)).toMatchObject({ success: true, data: { outcome: "unloaded" } });
		} finally {
			await host.dispose();
		}
	}, 60_000);

	it("still refuses unload while another connection holds the session", async () => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const caller = await host.connect();
			const other = await host.connect();
			const opened = await caller.request({ type: "open_session", cwd: host.cwd, retain_on_disconnect: true });
			const sessionId = opened.data?.sessionId;
			const sessionPath = opened.data?.state?.sessionFile;
			await caller.request({ type: "open_session", cwd: host.cwd, sessionPath });
			expect(await other.request({ type: "open_session", cwd: host.cwd, sessionPath })).toMatchObject({
				success: true,
			});
			const refused = await caller.request({ type: "unload_session", sessionId });
			expect(refused, JSON.stringify(refused)).toMatchObject({
				data: { outcome: "refused", reason: "attached", detail: "1 other client(s) attached" },
			});
		} finally {
			await host.dispose();
		}
	}, 60_000);
});

// wire contract v1.1: the attachment commands' own session_not_attached carries errorData { reason } only.
it("names why an attachment command found no attachment", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const responses = [
		await rig.router.handle({ id: "attach-unowned", type: "attach_session", ...ref }),
		await rig.router.handle({ id: "reclaim-unowned", type: "reclaim_session", ...ref }),
		await rig.send("stranger", { id: "release-unheld", type: "release_attachment", sessionId: ref.sessionId }),
	];
	expect(responses).toMatchObject([
		{ success: false, errorCode: "session_not_attached", errorData: { reason: "no_connection" } },
		{ success: false, errorCode: "session_not_attached", errorData: { reason: "no_connection" } },
		{ success: false, errorCode: "session_not_attached", errorData: { reason: "not_attached" } },
	]);
	for (const response of responses) expect(attachmentWireResponse.safeParse(response).success).toBe(true);
});

// senpi#3814 review L3: open_session is exempt from the gate, but a sessionId on it routes nothing.
it("never lets an open_session carrying a foreign sessionId reach that session", async () => {
	process.env.SENPI_RPC_REQUIRE_ATTACH = "1";
	await using rig = await attachmentRig();
	const ref = await rig.session();
	// open_session declares no sessionId; a client can still put one on the wire.
	const foreign = { sessionId: ref.sessionId };
	const opened = await rig.send("stranger", { id: "open-foreign", type: "open_session", cwd: rig.dir, ...foreign });
	expect(opened).toMatchObject({ success: true });
	expect((opened?.data as { sessionId?: string } | undefined)?.sessionId).not.toBe(ref.sessionId);
	expect(rig.registry.peek(ref.sessionId)?.attachments).toBe(1);
	expect(
		await rig.send("stranger", { id: "mutate", type: "append_user_message", sessionId: ref.sessionId, content: "x" }),
	).toMatchObject({ success: false, errorCode: "session_not_attached" });
});
