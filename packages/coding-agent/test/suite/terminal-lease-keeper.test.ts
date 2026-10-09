import { existsSync } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeaseKeeper, type LeaseKeeper } from "../../src/core/extensions/builtin/terminal/lease-keeper.ts";
import {
	acquireTerminalLease,
	LEASE_RECORD_VERSION,
} from "../../src/core/extensions/builtin/terminal/manifest-lease.ts";

const BOOT = 1_790_000_000_000;
const NOW = BOOT + 3_600_000;
const HOLDER_PID = 424_242;
const HOLDER_START = NOW - 600_000;
const TICK_MS = 10_000;

const createdDirs: string[] = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	for (const keeper of keepers.splice(0)) {
		keeper.stop();
		await keeper.settled();
	}
	vi.useRealTimers();
	for (const dir of createdDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-lease-keeper-"));
	createdDirs.push(dir);
	return dir;
}

async function writeForeignLease(dir: string, token = "holder-token"): Promise<string> {
	const path = join(dir, "s.lease");
	await writeFile(
		path,
		JSON.stringify({
			v: LEASE_RECORD_VERSION,
			token,
			pid: HOLDER_PID,
			startedAtMs: HOLDER_START,
			bootAtMs: BOOT,
			processStartedAtMs: HOLDER_START,
			acquiredAtMs: HOLDER_START,
		}),
		"utf8",
	);
	return path;
}

const self = { pid: process.pid, bootAtMs: BOOT, processStartedAtMs: NOW - 5_000 };

const keepers: LeaseKeeper[] = [];

function keeperFor(dir: string, holderAlive: () => boolean, onTakeover = vi.fn()) {
	const spawnSpy = vi.fn();
	const keeper = createLeaseKeeper({
		dir,
		encodedSessionId: "s",
		intervalMs: TICK_MS,
		now: () => NOW,
		self,
		isProcessAlive: (pid: number) => (pid === HOLDER_PID ? holderAlive() : true),
		readProcessStartMs: async (pid: number) => {
			spawnSpy(pid);
			return HOLDER_START;
		},
		onTakeover,
	});
	keepers.push(keeper);
	return { keeper, onTakeover, spawnSpy };
}

async function ticks(count: number): Promise<void> {
	for (let index = 0; index < count; index += 1) {
		await vi.advanceTimersByTimeAsync(TICK_MS);
		for (const keeper of keepers) await keeper.settled();
	}
}

describe("terminal lease keeper", () => {
	it("keeps waiting after a failed tick and still takes over once the holder is gone", async () => {
		const dir = await tempDir();
		await writeForeignLease(dir);
		// The keeper's own liveness check swallows probe errors, but the acquire it runs does not:
		// the first acquire's probe throws (an unexpected errno), so that tick fails.
		let acquireProbeCalls = 0;
		const errors: unknown[] = [];
		const onTakeover = vi.fn();
		const keeper = createLeaseKeeper({
			dir,
			encodedSessionId: "s",
			intervalMs: TICK_MS,
			now: () => NOW,
			self,
			isProcessAlive: (pid: number) => {
				if (pid !== HOLDER_PID) return true;
				acquireProbeCalls += 1;
				if (acquireProbeCalls === 1) throw Object.assign(new Error("probe failed"), { code: "EIO" });
				return false;
			},
			readProcessStartMs: async () => HOLDER_START,
			onTakeover,
			onError: (error) => errors.push(error),
		});
		keepers.push(keeper);
		keeper.start(null);
		await ticks(1);
		expect(errors).toHaveLength(1);
		expect(keeper.state).toBe("waiting");
		await ticks(1);
		expect(onTakeover).toHaveBeenCalledTimes(1);
		expect(keeper.state).toBe("owner");
	});

	it("hands the lease back when stop() lands while its takeover acquire is in flight", async () => {
		const dir = await tempDir();
		const path = await writeForeignLease(dir);
		// The tick sees the holder gone; the acquire then finds the pid answering again (reused by a
		// process that started an hour later), and stop() lands inside that probe: mid-acquire.
		let aliveChecks = 0;
		const onTakeover = vi.fn();
		const keeper: LeaseKeeper = createLeaseKeeper({
			dir,
			encodedSessionId: "s",
			intervalMs: TICK_MS,
			now: () => NOW,
			self,
			isProcessAlive: (pid: number) => pid !== HOLDER_PID || ++aliveChecks > 1,
			readProcessStartMs: async () => {
				keeper.stop();
				return HOLDER_START + 3_600_000;
			},
			onTakeover,
		});
		keepers.push(keeper);
		keeper.start({ pid: HOLDER_PID, startedAtMs: HOLDER_START });
		await vi.advanceTimersByTimeAsync(TICK_MS);
		await keeper.settled();
		expect(onTakeover).not.toHaveBeenCalled();
		expect(keeper.state).toBe("stopped");
		expect(existsSync(path)).toBe(false);
	});

	it("stays a waiter while the holder is alive and never spawns per tick", async () => {
		const dir = await tempDir();
		await writeForeignLease(dir);
		const { keeper, onTakeover, spawnSpy } = keeperFor(dir, () => true);
		keeper.start({ pid: HOLDER_PID, startedAtMs: HOLDER_START });
		await ticks(5);
		expect(onTakeover).not.toHaveBeenCalled();
		expect(keeper.state).toBe("waiting");
		expect(spawnSpy).not.toHaveBeenCalled();
		keeper.stop();
	});

	it("takes over exactly once when the holder's lease file disappears and then stops ticking", async () => {
		const dir = await tempDir();
		const path = await writeForeignLease(dir);
		const tickSpy = vi.fn();
		const { keeper, onTakeover } = keeperFor(dir, () => true);
		keeper.onTick = tickSpy;
		keeper.start({ pid: HOLDER_PID, startedAtMs: HOLDER_START });
		await ticks(1);
		await unlink(path);
		await ticks(2);
		expect(onTakeover).toHaveBeenCalledTimes(1);
		expect(onTakeover.mock.calls[0]?.[0]).toMatchObject({ acquired: true, pid: process.pid });
		expect(keeper.state).toBe("owner");
		const ticksAtTakeover = tickSpy.mock.calls.length;
		await ticks(3);
		expect(tickSpy.mock.calls.length).toBe(ticksAtTakeover);
	});

	it("takes over when the holder pid dies even though its lease file remains", async () => {
		const dir = await tempDir();
		await writeForeignLease(dir);
		let alive = true;
		const { keeper, onTakeover } = keeperFor(dir, () => alive);
		keeper.start({ pid: HOLDER_PID, startedAtMs: HOLDER_START });
		await ticks(2);
		expect(onTakeover).not.toHaveBeenCalled();
		alive = false;
		await ticks(1);
		expect(onTakeover).toHaveBeenCalledTimes(1);
	});

	it("lets exactly one of two racing waiters win the freed lease", async () => {
		const dir = await tempDir();
		const path = await writeForeignLease(dir);
		const a = keeperFor(dir, () => true);
		const b = keeperFor(dir, () => true);
		a.keeper.start({ pid: HOLDER_PID, startedAtMs: HOLDER_START });
		b.keeper.start({ pid: HOLDER_PID, startedAtMs: HOLDER_START });
		await unlink(path);
		await ticks(3);
		const wins = a.onTakeover.mock.calls.length + b.onTakeover.mock.calls.length;
		expect(wins).toBe(1);
		expect([a.keeper.state, b.keeper.state].sort()).toEqual(["owner", "waiting"]);
		a.keeper.stop();
		b.keeper.stop();
	});

	it("never fires after stop(), and stop() is idempotent", async () => {
		const dir = await tempDir();
		const path = await writeForeignLease(dir);
		const { keeper, onTakeover } = keeperFor(dir, () => true);
		keeper.start({ pid: HOLDER_PID, startedAtMs: HOLDER_START });
		keeper.stop();
		keeper.stop();
		await unlink(path);
		await ticks(3);
		expect(onTakeover).not.toHaveBeenCalled();
		expect(keeper.state).toBe("stopped");
	});

	it("re-classifies when the holder hands the lease to another live process", async () => {
		const dir = await tempDir();
		await writeForeignLease(dir, "first-holder");
		const { keeper, onTakeover } = keeperFor(dir, () => true);
		keeper.start({ pid: HOLDER_PID, startedAtMs: HOLDER_START });
		await ticks(1);
		const other = await acquireTerminalLease({
			dir: await tempDir(),
			encodedSessionId: "unrelated",
			now: () => NOW,
			self,
		});
		expect(other.acquired).toBe(true);
		await writeForeignLease(dir, "second-holder");
		await ticks(2);
		expect(onTakeover).not.toHaveBeenCalled();
		expect(keeper.state).toBe("waiting");
		keeper.stop();
	});
});
