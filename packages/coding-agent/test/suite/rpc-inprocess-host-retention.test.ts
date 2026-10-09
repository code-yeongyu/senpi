import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opened, transcriptLines } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

/** Idle-eviction window used by the retention cases; parking happens at twice this. */
const IDLE_WINDOW_MS = 1_000;
/** Empty-host exit window used by the retention cases. */
const EMPTY_EXIT_MS = 5_000;
/** Timer-only fakes plus `Date`: the registry's idle clock is `Date.now`, `setImmediate` stays real. */
const IDLE_CLOCK_FAKES = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;

const scratches: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function rigDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-inprocess-retain-"));
	scratches.push(dir);
	return dir;
}

describe("session retention on the in-process runtime", () => {
	it("keeps a retained session listed and re-attachable after its only connection drops", async () => {
		// Given: a retained idle session owned by exactly one connection.
		vi.useFakeTimers({ toFake: [...IDLE_CLOCK_FAKES] });
		const dir = await rigDir();
		await using rig = createInProcessRig(dir, { idleEvictionMs: 60_000 });
		const path = join(dir, "retained.jsonl");
		const session = opened(await rig.open("conn-a", { cwd: dir, sessionPath: path, retain_on_disconnect: true }), 0);

		// When: that connection drops and two seconds of host time pass.
		await rig.drop("conn-a");
		await vi.advanceTimersByTimeAsync(2_000);

		// Then: the session is still listed, detached, and a later open attaches to it.
		expect(await rig.list()).toEqual([
			expect.objectContaining({ sessionId: session.sessionId, status: "open", attachments: 0 }),
		]);
		const reattached = opened(await rig.open("conn-b", { cwd: dir, sessionPath: session.state.sessionFile }), 0);
		expect(reattached).toMatchObject({ sessionId: session.sessionId, attached: true });
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId: session.sessionId, attachments: 1 })]);
	});

	it("runs a retained session's turn to settlement after its client drops", async () => {
		// Given: a retained session with one settled turn on disk and a second in flight.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const session = opened(
			await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "midturn.jsonl"), retain_on_disconnect: true }),
			0,
		);
		const turn = rig.turns.get(session.state.sessionFile);
		if (!turn) throw new Error("No turn control for the opened session");
		turn.start();
		turn.finish();
		const before = transcriptLines(session.state.sessionFile);
		turn.start();

		// When: the only connection drops mid-turn and the turn settles afterwards.
		await rig.drop("conn-a");
		turn.finish();
		await rig.settle();

		// Then: the run was never aborted, its assistant message reached the transcript,
		// and the session outlived the client that started it.
		expect(turn.aborted).toBe(false);
		expect(transcriptLines(session.state.sessionFile)).toBe(before + 1);
		expect(await rig.list()).toEqual([
			expect.objectContaining({ sessionId: session.sessionId, status: "open", attachments: 0 }),
		]);
	});

	it("closes a session opened without the flag when its connection drops", async () => {
		// Given: a session opened with today's defaults.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const path = join(dir, "default.jsonl");
		const session = opened(await rig.open("conn-a", { cwd: dir, sessionPath: path }), 0);
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId: session.sessionId, attachments: 1 })]);

		// When: its only connection drops.
		await rig.drop("conn-a");

		// Then: it is torn down exactly as before the flag existed - gone from the listing,
		// its path released (the reopen creates a new handle instead of attaching), and the
		// host never reports it as parked.
		expect(await rig.list()).toEqual([]);
		const reopened = opened(await rig.open("conn-b", { cwd: dir, sessionPath: session.state.sessionFile }), 0);
		expect(reopened.attached).toBeUndefined();
		expect(reopened.sessionId).not.toBe(session.sessionId);
		expect(rig.records().filter((record) => record.type === "session_parked")).toEqual([]);
	});

	it("closes a retained detached session on an explicit close_session", async () => {
		// Given: a retained session that survived its owner's drop and was re-attached.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const session = opened(
			await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "explicit.jsonl"), retain_on_disconnect: true }),
			0,
		);
		await rig.drop("conn-a");
		expect(opened(await rig.open("conn-b", { cwd: dir, sessionPath: session.state.sessionFile }), 0)).toMatchObject({
			attached: true,
		});

		// When: the attached connection closes it explicitly.
		await rig.close("conn-b", session.sessionId);

		// Then: retention never outranks an explicit close.
		expect(await rig.list()).toEqual([]);
		expect(rig.records()).toContainEqual(
			expect.objectContaining({ type: "session_closed", sessionId: session.sessionId }),
		);
	});

	it("parks a retained session at the idle window and tells the connection that stayed attached", async () => {
		// Given: a retained session opened by one connection and attached by a second.
		vi.useFakeTimers({ toFake: [...IDLE_CLOCK_FAKES] });
		const dir = await rigDir();
		await using rig = createInProcessRig(dir, { idleEvictionMs: IDLE_WINDOW_MS });
		const session = opened(
			await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "parked.jsonl"), retain_on_disconnect: true }),
			0,
		);
		expect(opened(await rig.open("conn-b", { cwd: dir, sessionPath: session.state.sessionFile }), 0)).toMatchObject({
			attached: true,
		});
		await rig.drop("conn-a");

		// When: the idle window elapses with the session detached from its opener.
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 2);
		await rig.settle();

		// Then: the still-attached connection is told the session was PARKED - never closed -
		// and its path reopens as a fresh session.
		expect(rig.recordsFor("conn-b")).toContainEqual({
			type: "session_parked",
			sessionId: session.sessionId,
			sessionPath: session.state.sessionFile,
		});
		expect(rig.records().filter((record) => record.type === "session_closed")).toEqual([]);
		expect(await rig.list()).toEqual([]);
		const reopened = opened(await rig.open("conn-b", { cwd: dir, sessionPath: session.state.sessionFile }), 0);
		expect(reopened.attached).toBeUndefined();
		expect(reopened.sessionId).not.toBe(session.sessionId);
	});

	it("exits the empty host once its only retained session has been parked", async () => {
		// Given: a retained session whose only connection dropped, on a host with both windows armed.
		vi.useFakeTimers({ toFake: [...IDLE_CLOCK_FAKES] });
		const dir = await rigDir();
		const onEmptyExit = vi.fn();
		await using rig = createInProcessRig(dir, {
			idleEvictionMs: IDLE_WINDOW_MS,
			emptyExitMs: EMPTY_EXIT_MS,
			onEmptyExit,
		});
		const session = opened(
			await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "exit.jsonl"), retain_on_disconnect: true }),
			0,
		);
		await rig.drop("conn-a");

		// A live retained session is occupancy: the empty-host window does not start.
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS / 2);
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId: session.sessionId, attachments: 0 })]);

		// When: it is parked by the idle sweep and the empty-host window then elapses.
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 2);
		expect(await rig.list()).toEqual([]);
		expect(onEmptyExit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(EMPTY_EXIT_MS * 2);

		// Then: a parked session holds nothing open - the host exits exactly once.
		expect(onEmptyExit).toHaveBeenCalledTimes(1);
	});

	it("refuses close_session from a connection that never attached to the session", async () => {
		// Given: a retained session owned by one connection, and a second connection that
		// only ever listed it (routing handles are public on a shared host).
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const session = opened(
			await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "owned.jsonl"), retain_on_disconnect: true }),
			0,
		);

		// When: the never-attached connection closes it by that handle.
		const refusal = await rig.close("conn-b", session.sessionId);

		// Then: the close is refused and the session keeps its owner's attachment.
		expect(refusal).toMatchObject({ command: "close_session", success: false, error: "unknown_session" });
		expect(await rig.list()).toEqual([
			expect.objectContaining({ sessionId: session.sessionId, status: "open", attachments: 1 }),
		]);
		expect(rig.records().filter((record) => record.type === "session_closed")).toEqual([]);
	});
});
