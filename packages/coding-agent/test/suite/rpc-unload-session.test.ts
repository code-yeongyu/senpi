import { describe, expect, it } from "vitest";
import { effectHostWorld, effectOf, openSession, settledTurn } from "./rpc-effect-host-support.ts";

// senpi#3225: unload_session frees a loaded session, parks it with a reason, and open_session reopens it.

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

describe("unload_session", () => {
	it("unloads an idle session: parked with reason unloaded, gone from the listing, reopened by path with its transcript", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		await settledTurn(client, opened.sessionId);
		const parked = client.wait((record) => record.type === "session_parked" && record.sessionId === opened.sessionId);

		const unloaded = await client.request({ type: "unload_session", sessionId: opened.sessionId, effectId: "u1" });

		expect(unloaded).toMatchObject({
			success: true,
			data: { outcome: "unloaded", sessionPath: opened.sessionPath, effectId: "u1", state: "done" },
		});
		expect(await parked).toMatchObject({ sessionPath: opened.sessionPath, reason: "unloaded" });
		const listed = await client.request({ type: "list_sessions" });
		expect(((listed.data?.sessions ?? []) as { sessionId: string }[]).map((row) => row.sessionId)).not.toContain(
			opened.sessionId,
		);
		const reopened = await openSession(client, { sessionPath: opened.sessionPath });
		const state = await client.request({ type: "get_state", sessionId: reopened.sessionId });
		expect(state.success).toBe(true);
		expect(JSON.stringify(await world.readEntries(opened.sessionPath))).toContain("warm up");
		await host.stop();
	}, 240_000);

	it("refuses a running turn with a reason and an action, then unloads it with interrupt", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === opened.sessionId);
		await client.request({ type: "prompt", sessionId: opened.sessionId, message: "keep running" });
		await started;

		const refused = await client.request({ type: "unload_session", sessionId: opened.sessionId });
		const interrupted = await client.request({
			type: "unload_session",
			sessionId: opened.sessionId,
			interrupt: true,
		});

		expect(refused).toMatchObject({ success: true, data: { outcome: "refused", reason: "turn_active" } });
		expect(String(refused.data?.action)).toContain("interrupt");
		expect(interrupted).toMatchObject({ success: true, data: { outcome: "unloaded" } });
		await host.stop();
	}, 240_000);

	it("keeps a queued id-less steer through the unload and restores it on the reopen", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		await client.request({ type: "steer", sessionId: opened.sessionId, message: "still owed" });

		const unloaded = await client.request({ type: "unload_session", sessionId: opened.sessionId });
		const reopened = await openSession(client, { sessionPath: opened.sessionPath });
		const state = await client.request({ type: "get_state", sessionId: reopened.sessionId });

		expect(unloaded).toMatchObject({ data: { outcome: "unloaded" } });
		expect(((state.data?.ordered ?? []) as { text: string }[]).map((input) => input.text)).toEqual(["still owed"]);
		await host.stop();
	}, 240_000);

	it("with clearQueue: true restores nothing on the reopen and closes each cleared input as cleared (senpi#3412)", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		const queued = await client.request({
			type: "steer",
			sessionId: opened.sessionId,
			message: "with an id",
			clientMessageId: "c1",
		});
		await client.request({ type: "steer", sessionId: opened.sessionId, message: "without an id" });
		expect(queued).toMatchObject({ success: true, data: { admission: { state: "queued" } } });

		const unloaded = await client.request({ type: "unload_session", sessionId: opened.sessionId, clearQueue: true });
		const reopened = await openSession(client, { sessionPath: opened.sessionPath });
		const state = await client.request({ type: "get_state", sessionId: reopened.sessionId });
		const status = await client.request({
			type: "get_effect_status",
			effectId: "c1",
			sessionPath: opened.sessionPath,
		});

		expect(unloaded).toMatchObject({ data: { outcome: "unloaded" } });
		expect(state.data?.ordered ?? []).toEqual([]);
		expect(effectOf(status)).toMatchObject({
			kind: "input",
			state: "failed",
			outcome: { kind: "cleared", action: expect.any(String) },
		});
		await host.stop();
	}, 240_000);

	it("clear_queue closes a queued input as cleared, not completed (senpi#3412)", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		await client.request({
			type: "steer",
			sessionId: opened.sessionId,
			message: "never sent",
			clientMessageId: "q1",
		});

		const cleared = await client.request({ type: "clear_queue", sessionId: opened.sessionId });
		const status = await client.request({
			type: "get_effect_status",
			effectId: "q1",
			sessionPath: opened.sessionPath,
		});

		expect(cleared).toMatchObject({ success: true });
		expect(effectOf(status)).toMatchObject({
			kind: "input",
			state: "failed",
			outcome: { kind: "cleared", action: expect.any(String) },
		});
		await host.stop();
	}, 240_000);

	it("refuses while a child session it started is open here, and leaves the child running with children: detach", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const parent = await openSession(client, { cwd: world.cwd, ...MODEL });
		const parentState = await client.request({ type: "get_state", sessionId: parent.sessionId });
		const child = await openSession(client, {
			cwd: world.cwd,
			...MODEL,
			kind: "worker",
			context: { parent_session_id: String(parentState.data?.sessionId) },
		});

		const refused = await client.request({ type: "unload_session", sessionId: parent.sessionId });
		const detached = await client.request({
			type: "unload_session",
			sessionId: parent.sessionId,
			children: "detach",
		});
		const listed = await client.request({ type: "list_sessions", include_workers: true });

		expect(refused).toMatchObject({ data: { outcome: "refused", reason: "children_live" } });
		expect(String(refused.data?.action)).toContain("detach");
		expect(detached).toMatchObject({ data: { outcome: "unloaded" } });
		const rows = ((listed.data?.sessions ?? []) as { sessionId: string }[]).map((row) => row.sessionId);
		expect(rows).toContain(child.sessionId);
		expect(rows).not.toContain(parent.sessionId);
		await host.stop();
	}, 240_000);

	it("refuses while extension work is live, even with interrupt, and unloads it only with force", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		await client.request({ type: "prompt", sessionId: opened.sessionId, message: "/busyext" });

		const refused = await client.request({ type: "unload_session", sessionId: opened.sessionId, interrupt: true });
		const forced = await client.request({ type: "unload_session", sessionId: opened.sessionId, force: true });

		expect(refused).toMatchObject({ data: { outcome: "refused", reason: "extension_work" } });
		expect(String(refused.data?.detail)).toContain("test-background-job");
		expect(String(refused.data?.action)).toContain("force");
		expect(forced).toMatchObject({ data: { outcome: "unloaded" } });
		await host.stop();
	}, 240_000);

	it("refuses while another client is attached, and unloads with force, parking it for that client too", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const owner = await host.connect();
		const other = await host.connect();
		const opened = await openSession(owner, { cwd: world.cwd, ...MODEL });
		await openSession(other, { sessionPath: opened.sessionPath });
		const otherParked = other.wait((record) => record.type === "session_parked");

		const refused = await owner.request({ type: "unload_session", sessionId: opened.sessionId });
		const forced = await owner.request({ type: "unload_session", sessionId: opened.sessionId, force: true });

		expect(refused).toMatchObject({ data: { outcome: "refused", reason: "attached" } });
		expect(forced).toMatchObject({ data: { outcome: "unloaded" } });
		expect(await otherParked).toMatchObject({ reason: "unloaded" });
		await host.stop();
	}, 240_000);
});
