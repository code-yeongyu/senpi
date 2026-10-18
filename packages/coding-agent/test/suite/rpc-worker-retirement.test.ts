import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-worker-retirement-"));
	directories.push(dir);
	return dir;
}

it("parks a completed detached worker on the next sweep and reopens its durable history", async () => {
	// Given: a retained worker with a persisted result, disconnected longer than the
	// early-retirement grace age before the idle window.
	const dir = await directory();
	let now = 0;
	await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 60_000 });
	const first = opened(
		await rig.send("owner", {
			id: "open",
			type: "open_session",
			cwd: dir,
			kind: "worker",
			retain_on_disconnect: true,
		}),
		0,
	);
	const entry = rig.registry.peek(first.sessionId);
	const turn = rig.turns.get(first.state.sessionFile);
	if (!entry || !turn) throw new Error("Worker did not open");
	turn.start();
	turn.finish();
	await rig.drop("owner");

	// When: the occupancy sweep observes the completed worker.
	now = 5_000;
	rig.router.sweepIdleSessions();
	expect(entry.state).toBe("closing");
	await entry.closeCompletion;

	// Then: the old runtime is gone, but reopening preserves the identity and result.
	expect(rig.registry.peek(first.sessionId)).toBeUndefined();
	const resumed = opened(await rig.open("resume", { cwd: dir, sessionPath: first.state.sessionFile }), 1);
	expect(resumed.sessionId).not.toBe(first.sessionId);
	expect(resumed.state.sessionId).toBe(first.state.sessionId);
	expect(rig.registry.peek(resumed.sessionId)?.runtime?.session.sessionManager.getEntries()).toContainEqual(
		expect.objectContaining({ type: "message", message: expect.objectContaining({ role: "assistant" }) }),
	);
});

it("uses the normal idle deadline when a zero-attachment worker has no detach stamp", async () => {
	// Given: a flushed worker with no client ownership and no recorded disconnect.
	const dir = await directory();
	let now = 0;
	await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 60_000 });
	const first = opened(await rig.open("owner", { cwd: dir, kind: "worker", retain_on_disconnect: true }), 0);
	const entry = rig.registry.peek(first.sessionId);
	const turn = rig.turns.get(first.state.sessionFile);
	if (!entry || !turn) throw new Error("Worker did not open");
	turn.finish();
	entry.attachments = 0;
	expect(entry.detachedAt).toBeUndefined();

	// When: the early-retirement grace passes, followed by the ordinary idle deadline.
	now = 5_000;
	rig.router.sweepIdleSessions();
	expect(entry.state).toBe("open");
	now = 60_000;
	rig.router.sweepIdleSessions();

	// Then: no detach stamp prevents early retirement, not all retirement forever.
	expect(entry.state).toBe("closing");
	await entry.closeCompletion;
	expect(rig.registry.peek(first.sessionId)).toBeUndefined();
});

it.each(["attached", "unflushed", "turn", "wake", "queued", "delivery", "prompt", "request"] as const)(
	"keeps a retained worker with %s work out of early retirement",
	async (reason) => {
		// Given: a worker that has one reason it cannot be safely retired.
		const dir = await directory();
		const pending = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let now = 0;
		await using rig = createInProcessRig(
			dir,
			{ now: () => now, idleEvictionMs: 60_000 },
			async () => {
				entered.resolve();
				await pending.promise;
			},
			{ pendingPrompts: () => (reason === "prompt" ? [pending.promise] : []) },
		);
		const first = opened(
			await rig.send("owner", {
				id: "open",
				type: "open_session",
				cwd: dir,
				kind: "worker",
				retain_on_disconnect: true,
			}),
			0,
		);
		const entry = rig.registry.peek(first.sessionId);
		const session = entry?.runtime?.session;
		const turn = rig.turns.get(first.state.sessionFile);
		if (!entry || !session || !turn) throw new Error("Worker did not open");
		if (reason !== "unflushed") turn.finish();
		if (reason === "turn") turn.start();
		if (reason === "wake") vi.spyOn(session, "isSessionBusy", "get").mockReturnValue(true);
		if (reason === "queued") Object.defineProperty(session, "pendingMessageCount", { get: () => 1 });
		if (reason === "delivery") turn.pendingDeliveries.push("unwritten");
		if (reason !== "attached") await rig.drop("owner");
		const request =
			reason === "request"
				? rig.send("observer", { id: "state", type: "get_state", sessionId: first.sessionId })
				: undefined;
		if (request) await entered.promise;

		// When: the host considers early retirement.
		try {
			now = 5_000;
			// "queued"/"delivery" already sat past the deadline; a held prompt or request must
			// also protect the worker past it, not just at time zero.
			if (reason === "queued" || reason === "delivery" || reason === "prompt" || reason === "request") now = 60_001;
			rig.router.sweepIdleSessions();

			// Then: work and the runtime are preserved.
			expect(entry.state).toBe("open");
			expect(turn.aborted).toBe(false);
		} finally {
			pending.resolve();
			await request;
		}
	},
);

it("keeps a quiet detached interactive session for its normal retention window", async () => {
	// Given: an interactive retained session with persisted history.
	const dir = await directory();
	await using rig = createInProcessRig(dir, { idleEvictionMs: 60_000 });
	const first = opened(await rig.open("owner", { cwd: dir, retain_on_disconnect: true }), 0);
	rig.turns.get(first.state.sessionFile)?.finish();
	await rig.drop("owner");

	// When: a sweep runs before the configured idle window.
	rig.router.sweepIdleSessions();

	// Then: a reconnect still attaches to the same runtime.
	const resumed = opened(await rig.open("resume", { cwd: dir, sessionPath: first.state.sessionFile }), 1);
	expect(resumed).toMatchObject({ sessionId: first.sessionId, attached: true });
});
