import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory(prefix = "senpi-session-observation-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	directories.push(dir);
	return dir;
}

it.each([
	{ kind: "interactive", retain: true },
	{ kind: "interactive", retain: false },
	{ kind: "worker", retain: true },
	{ kind: "worker", retain: false },
] as const)(
	"keeps an attached $kind session (retained: $retain) alive while a client polls get_state",
	async (combo) => {
		// Given: an attached session with persisted history whose only traffic is status polling.
		const dir = await directory();
		let now = 0;
		const handled: string[] = [];
		await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 1_000 }, async (command) => {
			handled.push(command.type);
		});
		const first = opened(
			await rig.open("owner", {
				cwd: dir,
				retain_on_disconnect: combo.retain,
				...(combo.kind === "worker" ? { kind: "worker" } : {}),
			}),
			0,
		);
		const entry = rig.registry.peek(first.sessionId);
		const turn = rig.turns.get(first.state.sessionFile);
		if (!entry || !turn) throw new Error("Session did not open");
		turn.finish();

		// When: the client polls it across what would have been the original deadline.
		now = 999;
		await rig.send("owner", { id: "read", type: "get_state", sessionId: first.sessionId });
		now = 1_000;
		rig.router.sweepIdleSessions();

		// Then: no park/evict event, the registry still lists it open and attached, and the handle still routes.
		expect(entry.state).toBe("open");
		const lifecycle = rig
			.records()
			.filter(
				(record) =>
					record.sessionId === first.sessionId &&
					(record.type === "session_parked" || record.type === "session_closed"),
			);
		expect(lifecycle).toEqual([]);
		expect(rig.registry.peek(first.sessionId)?.attachments).toBeGreaterThan(0);
		await rig.send("owner", { id: "read-2", type: "get_state", sessionId: first.sessionId });
		expect(entry.state).toBe("open");
		expect(handled).toEqual(["get_state", "get_state"]);
	},
);

it.each([
	"get_state",
	"get_messages",
	"get_entries",
	"get_tree",
	"get_session_stats",
	"get_commands",
	"get_loaded_surfaces",
	"memory_report",
] as const)("does not let %s polling renew a detached session's idle lifetime", async (type) => {
	// Given: an otherwise idle detached session, almost at its eviction deadline.
	const dir = await directory();
	let now = 0;
	await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 1_000 });
	const first = opened(await rig.open("owner", { cwd: dir, retain_on_disconnect: true }), 0);
	const entry = rig.registry.peek(first.sessionId);
	if (!entry) throw new Error("Session did not open");
	await rig.drop("owner");
	now = 999;

	// When: a client reads it just before the original deadline, then the sweep runs.
	await rig.send("observer", { id: "read", type, sessionId: first.sessionId });
	now = 1_000;
	rig.router.sweepIdleSessions();

	// Then: observation has not bought another idle window.
	expect(entry.state).toBe("closing");
	await entry.closeCompletion;
	expect(rig.registry.peek(first.sessionId)).toBeUndefined();
});

it("renews the idle window for a command that changes the session", async () => {
	// Given: an idle session close to its deadline.
	const dir = await directory();
	let now = 0;
	await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 1_000 });
	const first = opened(await rig.open("owner", { cwd: dir }), 0);
	now = 999;

	// When: the client changes the name, then the old deadline passes.
	await rig.send("owner", { id: "name", type: "set_session_name", sessionId: first.sessionId, name: "active" });
	now = 1_000;
	rig.router.sweepIdleSessions();

	// Then: actual interaction still renews its lifetime.
	expect(rig.registry.peek(first.sessionId)?.state).toBe("open");
});

it("keeps a just-detached completed worker through its first sweeps so a reconnect stays cheap", async () => {
	// Given: a retained worker with a persisted result, dropped moments before the sweep.
	const dir = await directory("senpi-worker-reconnect-");
	let now = 0;
	await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 60_000 });
	const first = opened(await rig.open("owner", { cwd: dir, kind: "worker", retain_on_disconnect: true }), 0);
	const entry = rig.registry.peek(first.sessionId);
	const turn = rig.turns.get(first.state.sessionFile);
	if (!entry || !turn) throw new Error("Worker did not open");
	turn.start();
	turn.finish();
	await rig.drop("owner");

	// When: the sweep runs while the disconnect is still fresh.
	now = 1;
	rig.router.sweepIdleSessions();

	// Then: the live runtime survives, and a reconnect re-attaches to it rather than re-opening.
	expect(entry.state).toBe("open");
	const reattached = opened(await rig.open("owner", { cwd: dir, sessionPath: first.state.sessionFile }), 1);
	expect(reattached).toMatchObject({ sessionId: first.sessionId, attached: true });
});

it("starts a fresh retirement grace after a worker reconnects and detaches again", async () => {
	// Given: a completed worker that reconnects just before its first grace expires.
	const dir = await directory("senpi-worker-reconnect-");
	let now = 0;
	await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 60_000 });
	const first = opened(await rig.open("owner", { cwd: dir, kind: "worker", retain_on_disconnect: true }), 0);
	const entry = rig.registry.peek(first.sessionId);
	const turn = rig.turns.get(first.state.sessionFile);
	if (!entry || !turn) throw new Error("Worker did not open");
	turn.start();
	turn.finish();
	await rig.drop("owner");
	now = 4_999;
	const reattached = opened(await rig.open("owner", { cwd: dir, sessionPath: first.state.sessionFile }), 1);
	expect(reattached).toMatchObject({ sessionId: first.sessionId, attached: true });

	// When: it detaches again, the old grace no longer authorizes retirement.
	now = 5_000;
	await rig.drop("owner");
	now = 9_999;
	rig.router.sweepIdleSessions();
	expect(entry.state).toBe("open");
	now = 10_000;
	rig.router.sweepIdleSessions();

	// Then: retirement proceeds at the new boundary and preserves durable identity.
	expect(entry.state).toBe("closing");
	await entry.closeCompletion;
	expect(rig.registry.peek(first.sessionId)).toBeUndefined();
	const resumed = opened(await rig.open("owner", { cwd: dir, sessionPath: first.state.sessionFile }), 1);
	expect(resumed.sessionId).not.toBe(first.sessionId);
	expect(resumed.state.sessionId).toBe(first.state.sessionId);
});
