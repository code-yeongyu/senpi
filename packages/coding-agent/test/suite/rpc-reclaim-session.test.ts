import { expect, it, vi } from "vitest";
import { SocketEventSinkActor } from "../../src/modes/rpc/socket-event-fanout.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../src/modes/rpc/socket-peer-recovery.ts";
import { attachmentRig } from "./rpc-attachment-support.ts";
import { attachmentWireResponse } from "./rpc-attachment-wire-schema.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// senpi#3795: reclaim is one synchronous attach-and-claim, never an abort followed by a racy close.
it.each([0, 1, 3])("claims all %i pre-existing caller holds before teardown awaits", async (holds) => {
	await using rig = await attachmentRig();
	const ref = await rig.session(holds);
	const entry = rig.registry.peek(ref.sessionId);
	const turn = rig.turns.get(ref.sessionPath);
	if (!entry || !turn) throw new Error("Missing live session");
	turn.start();
	rig.teardown.hold();
	const reclaim = rig.send(holds === 0 ? "recovery" : "caller", { id: "reclaim", type: "reclaim_session", ...ref });
	try {
		expect(entry.state).toBe("closing");
		expect(entry.attachments).toBeLessThanOrEqual(0);
		const competing = await rig.send("competitor", { id: "late-attach", type: "attach_session", ...ref });
		expect(competing).toMatchObject({ success: false });
	} finally {
		rig.teardown.release();
		await reclaim;
	}
	expect(await reclaim).toMatchObject({ success: true });
	expect(turn.aborted).toBe(true);
	expect(await rig.list()).toEqual([]);
});

it("refuses attached_elsewhere, including an attach begun concurrently before reclaim", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const attach = rig.send("other", { id: "other", type: "attach_session", ...ref });
	const reclaim = rig.send("caller", { id: "reclaim", type: "reclaim_session", ...ref });
	expect(await attach).toMatchObject({ success: true });
	expect(await reclaim).toMatchObject({
		success: false,
		error: "attached_elsewhere",
		errorData: { attachments: 1 },
	});
	expect(await rig.list()).toContainEqual(
		expect.objectContaining({ sessionId: ref.sessionId, attachments: 2, status: "open" }),
	);
});

it.each(["durableSessionId", "expectedHostInstance"] as const)(
	"refuses a mismatching or missing %s without touching the session",
	async (field) => {
		await using rig = await attachmentRig();
		const ref = await rig.session();
		for (const value of ["stale", undefined]) {
			expect(
				await rig.send("caller", {
					id: `mismatch-${value}`,
					type: "reclaim_session",
					...ref,
					[field]: value,
				}),
			).toMatchObject({ success: false, error: "session_identity_mismatch" });
		}
		expect(await rig.list()).toContainEqual(expect.objectContaining({ attachments: 1, status: "open" }));
	},
);

it.each(["opening", "closing"] as const)("refuses a %s target without claiming its holds", async (state) => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const entry = rig.registry.peek(ref.sessionId);
	if (!entry) throw new Error("Missing entry");
	entry.state = state;
	try {
		expect(await rig.send("caller", { id: "busy", type: "reclaim_session", ...ref })).toMatchObject({
			success: false,
			error: "session_busy_lifecycle",
		});
		expect(entry.attachments).toBe(1);
	} finally {
		entry.state = "open";
	}
});

it("never opens or resumes a vanished path", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	await rig.close("caller", ref.sessionId);
	expect(await rig.send("caller", { id: "gone", type: "reclaim_session", ...ref })).toMatchObject({
		success: false,
		error: "unknown_session",
	});
	expect(await rig.list()).toEqual([]);
});

it("reclaims for client A without an extra response or ending client B's live session", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const other = opened(await rig.open("client-b", { cwd: rig.dir }), 1);
	const otherSessionId = other.sessionId;
	const beforeA = rig.recordsFor("caller").length;
	const beforeB = rig.recordsFor("client-b").length;
	const response = await rig.send("caller", { id: "reclaim-a", type: "reclaim_session", ...ref });
	expect(response).toMatchObject({ id: "reclaim-a", command: "reclaim_session", success: true });
	expect(
		rig
			.recordsFor("caller")
			.slice(beforeA)
			.filter((record) => record.type === "response"),
	).toEqual([]);
	expect(
		rig
			.recordsFor("client-b")
			.slice(beforeB)
			.filter(
				(record) =>
					record.type === "session_closed" ||
					record.type === "session_parked" ||
					(record.type === "response" && record.command === "close_session"),
			),
	).toEqual([]);
	expect(await rig.list()).toEqual([
		expect.objectContaining({ sessionId: otherSessionId, status: "open", attachments: 1 }),
	]);
	expect(await rig.close("client-b", otherSessionId)).toMatchObject({ success: true });
});

it("reports lifecycle busy before identity for an opening entry without a runtime", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const entry = rig.registry.peek(ref.sessionId);
	if (!entry) throw new Error("Missing entry");
	entry.state = "opening";
	const runtime = entry.runtime;
	entry.runtime = undefined;
	try {
		expect(
			await rig.send("caller", {
				id: "opening",
				type: "reclaim_session",
				...ref,
				durableSessionId: "not-published",
			}),
		).toMatchObject({ success: false, errorCode: "session_busy_lifecycle" });
		expect(entry.attachments).toBe(1);
	} finally {
		entry.state = "open";
		entry.runtime = runtime;
	}
});

it.each(["drain", "shutdown"] as const)("refuses reclaim during %s before admission", async (phase) => {
	await using rig = await attachmentRig();
	const ref = await rig.session(0);
	const entry = rig.registry.peek(ref.sessionId);
	const turn = rig.turns.get(ref.sessionPath);
	if (!entry || !turn) throw new Error("Missing live session");
	turn.start();
	if (phase === "shutdown") rig.teardown.hold();
	const shutdown = phase === "shutdown" ? rig.router.dispose() : undefined;
	if (phase === "drain") rig.router.beginDrain();
	const before = { state: entry.state, attachments: entry.attachments };
	try {
		const response = await rig.send("recovery", {
			id: "draining-reclaim",
			type: "reclaim_session",
			sessionPath: ref.sessionPath,
			durableSessionId: ref.durableSessionId,
			expectedHostInstance: ref.expectedHostInstance,
		});
		expect(response).toMatchObject({
			success: false,
			errorCode: "session_busy_lifecycle",
			errorData: { reason: "host_draining" },
		});
		expect(attachmentWireResponse.safeParse(response).success).toBe(true);
		expect(entry).toMatchObject(before);
		expect(
			await rig.send("recovery", {
				id: "no-recovery-hold",
				type: "release_attachment",
				sessionId: ref.sessionId,
			}),
		).toMatchObject({ success: false, errorCode: "session_not_attached" });
		if (phase === "drain") expect(turn.aborted).toBe(false);
	} finally {
		turn.finish();
		rig.teardown.release();
		await shutdown;
	}
});

it("removes a reclaimed session from the caller's resync attached list", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const recovery = vi.spyOn(SocketEventSinkActor.prototype, "enableRecovery");
	try {
		await rig.send("caller", {
			id: "resync",
			type: "set_client_info",
			width: 80,
			capabilities: [EVENT_RESYNC_CAPABILITY],
		});
		const snapshot = recovery.mock.calls[0]?.[0];
		if (!snapshot) throw new Error("Missing recovery snapshot");
		expect(snapshot("overflow")()).toContainEqual(expect.objectContaining({ sessionId: ref.sessionId }));
		expect(await rig.send("caller", { id: "reclaim", type: "reclaim_session", ...ref })).toMatchObject({
			success: true,
		});
		expect(snapshot("overflow")()).toEqual([]);
	} finally {
		recovery.mockRestore();
	}
});

it.each(["in-process", "worker"] as const)(
	"reclaims zero, one and several holds through a real %s socket",
	async (sessionRuntime) => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const caller = await host.connect();
			const protocol = await caller.request({ type: "get_protocol_info" });
			for (const holds of [0, 1, 3]) {
				const opened = await caller.request({ type: "open_session", cwd: host.cwd, retain_on_disconnect: true });
				expect(opened.success).toBe(true);
				const ref = {
					sessionId: opened.data?.sessionId,
					sessionPath: opened.data?.state?.sessionFile,
					durableSessionId: opened.data?.state?.sessionId,
					expectedHostInstance: protocol.data?.instanceId,
				};
				for (let index = 1; index < holds; index++)
					expect(await caller.request({ type: "attach_session", ...ref })).toMatchObject({ success: true });
				if (holds === 0)
					expect(await caller.request({ type: "release_attachment", sessionId: ref.sessionId })).toMatchObject({
						success: true,
					});
				expect(await caller.request({ type: "reclaim_session", ...ref })).toMatchObject({ success: true });
				expect((await caller.request({ type: "list_sessions" })).data?.sessions).toEqual([]);
			}
		} finally {
			await host.dispose();
		}
	},
	90_000,
);
