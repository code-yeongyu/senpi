import { expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { attachmentRig } from "./rpc-attachment-support.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";

// senpi#3795: temporary holds use disconnect semantics, never destructive close semantics.
it("releases one caller hold on one session and keeps the remaining event stream", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session(3);
	const other = opened(await rig.open("caller", { cwd: rig.dir }), 1);
	expect(
		await rig.send("caller", { id: "release", type: "release_attachment", sessionId: ref.sessionId }),
	).toMatchObject({
		success: true,
		data: { deferred: false },
	});
	expect(await rig.list()).toEqual([
		expect.objectContaining({ sessionId: ref.sessionId, attachments: 2 }),
		expect.objectContaining({ sessionId: other.sessionId, attachments: 1 }),
	]);
	expect(
		await rig.send("stranger", { id: "no-hold", type: "release_attachment", sessionId: ref.sessionId }),
	).toMatchObject({
		success: false,
		error: "session_not_attached",
	});
	await rig.close("caller", ref.sessionId);
	expect(await rig.list()).toContainEqual(expect.objectContaining({ sessionId: ref.sessionId, attachments: 1 }));
});

it("lets a non-retained in-process turn survive owner disconnect followed by temporary release", async () => {
	await using rig = await attachmentRig();
	const data = opened(await rig.open("owner", { cwd: rig.dir }), 0);
	const sessionId = data.sessionId;
	await rig.open("temporary", { cwd: rig.dir, sessionPath: data.state.sessionFile });
	const entry = rig.registry.peek(sessionId);
	const turn = rig.turns.get(data.state.sessionFile);
	if (!entry?.runtime || !turn) throw new Error("Missing runtime");
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const subscribe = vi.spyOn(entry.runtime.session, "subscribe").mockImplementation((listener) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	});
	try {
		turn.start();
		await rig.drop("owner");
		expect(await rig.send("temporary", { id: "release", type: "release_attachment", sessionId })).toMatchObject({
			success: true,
			data: { deferred: true },
		});
		expect(turn.aborted).toBe(false);
		expect(entry.state).toBe("open");
		// A released logical hold must not remain usable while its physical release is deferred.
		expect(await rig.close("temporary", sessionId)).toMatchObject({ success: false, error: "unknown_session" });
		turn.finish();
		for (const listener of [...listeners]) listener({ type: "agent_idle" });
		await rig.settle();
		expect(await rig.list()).toEqual([]);
	} finally {
		subscribe.mockRestore();
	}
});

it("returns deferred false while the host drain owns physical release", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const turn = rig.turns.get(ref.sessionPath);
	if (!turn) throw new Error("Missing turn");
	turn.start();
	rig.router.beginDrain();
	expect(
		await rig.send("caller", {
			id: "draining",
			type: "release_attachment",
			sessionId: ref.sessionId,
		}),
	).toMatchObject({ success: true, data: { deferred: false } });
	expect(rig.registry.peek(ref.sessionId)?.attachments).toBe(1);
	expect(turn.aborted).toBe(false);
	turn.finish();
});
