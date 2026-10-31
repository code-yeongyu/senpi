import { expect, it } from "vitest";
import { attachmentRig } from "./rpc-attachment-support.ts";
import { attachmentWireResponse } from "./rpc-attachment-wire-schema.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// senpi#3795: unlike open-by-path, a transient attach never creates a session or changes its profile.
it.each(["in-process", "worker"] as const)(
	"attaches only the selected live identity on a %s socket host",
	async (sessionRuntime) => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const owner = await host.connect();
			const caller = await host.connect();
			const opened = await owner.request({ type: "open_session", cwd: host.cwd, permissionPreset: "full-access" });
			expect(opened.success).toBe(true);
			const sessionId = opened.data?.sessionId;
			const durableSessionId = opened.data?.state?.sessionId;
			const protocol = await caller.request({ type: "get_protocol_info" });
			expect(protocol.data?.capabilities).toEqual(
				expect.arrayContaining(["attach_session", "release_attachment", "release_caller_aware", "reclaim_session"]),
			);
			expect(
				await caller.request({ type: "attach_session", sessionId, durableSessionId: "recycled" }),
			).toMatchObject({
				success: false,
				error: "session_identity_mismatch",
			});
			expect(
				await caller.request({
					type: "attach_session",
					sessionId,
					durableSessionId,
					expectedHostInstance: "old-host",
				}),
			).toMatchObject({ success: false, error: "session_identity_mismatch" });
			expect(await caller.request({ type: "attach_session", sessionId, durableSessionId })).toMatchObject({
				success: true,
				data: { sessionId, attached: true },
			});
			expect((await caller.request({ type: "list_sessions" })).data?.sessions).toEqual([
				expect.objectContaining({ sessionId, attachments: 2 }),
			]);
			await caller.request({ type: "release_attachment", sessionId });
			await owner.request({ type: "close_session", sessionId });
			expect(await caller.request({ type: "attach_session", sessionId, durableSessionId })).toMatchObject({
				success: false,
				error: "unknown_session",
			});
			expect((await caller.request({ type: "list_sessions" })).data?.sessions).toEqual([]);
		} finally {
			await host.dispose();
		}
	},
	60_000,
);

it("preserves every launch profile field and publishes an attach", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const entry = rig.registry.peek(ref.sessionId);
	if (!entry) throw new Error("Missing opened entry");
	const before = entry.profile;
	const status = await rig.send("observer", { id: "sub", type: "subscribe_sessions" });
	expect(status).toMatchObject({ success: true });
	expect(await rig.send("temporary", { id: "attach", type: "attach_session", ...ref })).toMatchObject({
		success: true,
	});
	expect(entry.profile).toBe(before);
	expect(rig.recordsFor("observer")).toContainEqual(
		expect.objectContaining({
			type: "session_status",
			lastChange: expect.objectContaining({ cause: "attach" }),
		}),
	);
});

// wire contract v1.1: attach_session is fenced like reclaim_session while the host drains or shuts down,
// with the v1 code session_busy_lifecycle and errorData.reason "host_draining".
it.each(["drain", "shutdown"] as const)("refuses attach during %s before admission", async (phase) => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const entry = rig.registry.peek(ref.sessionId);
	const turn = rig.turns.get(ref.sessionPath);
	if (!entry || !turn) throw new Error("Missing live session");
	// A running turn keeps the drain from parking the session, so the handle is still live.
	turn.start();
	if (phase === "shutdown") rig.teardown.hold();
	const shutdown = phase === "shutdown" ? rig.router.dispose() : undefined;
	if (phase === "drain") rig.router.beginDrain();
	const before = { state: entry.state, attachments: entry.attachments };
	try {
		const response = await rig.send("late", { id: "draining-attach", type: "attach_session", ...ref });
		expect(response).toMatchObject({
			success: false,
			errorCode: "session_busy_lifecycle",
			errorData: { reason: "host_draining" },
		});
		expect(attachmentWireResponse.safeParse(response).success).toBe(true);
		expect(entry).toMatchObject(before);
		expect(
			await rig.send("late", { id: "no-late-hold", type: "release_attachment", sessionId: ref.sessionId }),
		).toMatchObject({ success: false, errorCode: "session_not_attached" });
	} finally {
		turn.finish();
		rig.teardown.release();
		await shutdown;
	}
});
