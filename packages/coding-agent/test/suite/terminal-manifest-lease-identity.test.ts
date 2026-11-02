import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireTerminalLease,
	currentLeaseToken,
	LEASE_RECORD_VERSION,
	readLeaseRecord,
	releaseTerminalLease,
	retireLeaseToken,
} from "../../src/core/extensions/builtin/terminal/manifest-lease.ts";
import {
	BOOT_INSTANT_TOLERANCE_MS,
	ownProcessStartedAtMs,
	processBootAtMs,
} from "../../src/core/extensions/builtin/terminal/process-identity.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	for (const dir of createdDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-terminal-lease-id-"));
	createdDirs.push(dir);
	return dir;
}

const BOOT = 1_790_000_000_000;
const NOW = BOOT + 3_600_000;
const HOLDER_START = NOW - 600_000;
const alive = () => true;

function v2Record(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		v: LEASE_RECORD_VERSION,
		token: "holder-token",
		pid: 424_242,
		startedAtMs: HOLDER_START,
		bootAtMs: BOOT,
		processStartedAtMs: HOLDER_START,
		acquiredAtMs: HOLDER_START,
		...overrides,
	};
}

function selfIdentity(pid = process.pid) {
	return { pid, bootAtMs: BOOT, processStartedAtMs: NOW - 5_000 };
}

describe("terminal lease identity (v2)", () => {
	it("waits on a live reclaimer and breaks a lock whose holder is gone or whose pid was reused", async () => {
		const dir = await tempDir();
		const path = join(dir, "s.lease");
		const stale = JSON.stringify(v2Record({ pid: 2_147_000_002, token: "dead-holder" }));
		const reclaimer = { pid: 3_100_001, bootAtMs: processBootAtMs(), processStartedAtMs: NOW - 60_000 };
		let reclaimerStart = reclaimer.processStartedAtMs;
		let reclaimerAlive = true;
		const acquire = () =>
			acquireTerminalLease({
				dir,
				encodedSessionId: "s",
				now: () => NOW,
				self: selfIdentity(),
				isProcessAlive: (pid: number) => (pid === reclaimer.pid ? reclaimerAlive : pid !== 2_147_000_002),
				readProcessStartMs: async (pid: number) => (pid === reclaimer.pid ? reclaimerStart : NOW - 5_000),
			});
		await writeFile(path, stale, "utf8");
		await writeFile(`${path}.lock`, JSON.stringify(reclaimer), "utf8");
		// A live reclaimer holds the lock: the acquire waits on THAT process, never on the stale record.
		await expect(acquire()).resolves.toMatchObject({ acquired: false, holder: { pid: reclaimer.pid } });
		expect(await readFile(path, "utf8")).toBe(stale);
		// The reclaimer crashed and its pid now belongs to a process that started later: the lock is broken.
		reclaimerStart = NOW - 1_000;
		await expect(acquire()).resolves.toMatchObject({ acquired: true });
		expect(existsSync(`${path}.lock`)).toBe(false);
		// Same for a reclaimer that is simply gone.
		await releaseTerminalLease({ path, pid: process.pid });
		await writeFile(path, stale, "utf8");
		await writeFile(`${path}.lock`, JSON.stringify(reclaimer), "utf8");
		reclaimerStart = reclaimer.processStartedAtMs;
		reclaimerAlive = false;
		await expect(acquire()).resolves.toMatchObject({ acquired: true });
	});

	it("breaks a lock left under this process's own pid by an earlier process that wore it", async () => {
		const dir = await tempDir();
		const path = join(dir, "s.lease");
		const stale = JSON.stringify(v2Record({ pid: 2_147_000_005, token: "dead-holder" }));
		await writeFile(path, stale, "utf8");
		// Same pid as this process, but a start instant an hour earlier: a crashed predecessor's lock.
		await writeFile(
			`${path}.lock`,
			JSON.stringify({
				pid: process.pid,
				bootAtMs: processBootAtMs(),
				processStartedAtMs: ownProcessStartedAtMs() - 3_600_000,
			}),
			"utf8",
		);
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: (pid: number) => pid !== 2_147_000_005,
			readProcessStartMs: async () => NOW - 5_000,
		});
		expect(result.acquired).toBe(true);
		if (result.acquired) await releaseTerminalLease(result);
	});

	it("treats an unreadable lock as held until it is old enough to have been abandoned", async () => {
		const dir = await tempDir();
		const path = join(dir, "s.lease");
		const stale = JSON.stringify(v2Record({ pid: 2_147_000_004, token: "dead-holder" }));
		const acquire = () =>
			acquireTerminalLease({
				dir,
				encodedSessionId: "s",
				now: () => NOW,
				self: selfIdentity(),
				isProcessAlive: (pid: number) => pid !== 2_147_000_004,
				readProcessStartMs: async () => NOW - 5_000,
			});
		await writeFile(path, stale, "utf8");
		await writeFile(`${path}.lock`, "", "utf8");
		await expect(acquire()).rejects.toThrow(/kept changing/);
		expect(await readFile(path, "utf8")).toBe(stale);
		const old = new Date(Date.now() - 60_000);
		await utimes(`${path}.lock`, old, old);
		await expect(acquire()).resolves.toMatchObject({ acquired: true });
	});

	it("a slow reclaimer never deletes the fresh lease a faster one took from the same stale file", async () => {
		const dir = await tempDir();
		const path = join(dir, "s.lease");
		// The stale holder's pid answers but belongs to a later process (pid reuse), so both racers
		// must probe it; racer A is held inside that probe until racer B has fully acquired.
		await writeFile(path, JSON.stringify(v2Record({ pid: 2_147_000_001, token: "reused-holder" })), "utf8");
		let resumeA: () => void = () => {};
		const aHeld = new Promise<void>((resolve) => {
			resumeA = resolve;
		});
		let aEntered: () => void = () => {};
		const aInProbe = new Promise<void>((resolve) => {
			aEntered = resolve;
		});
		const racer = (pid: number, hold: boolean) => {
			let first = hold;
			return acquireTerminalLease({
				dir,
				encodedSessionId: "s",
				now: () => NOW,
				self: selfIdentity(pid),
				isProcessAlive: alive,
				readProcessStartMs: async () => {
					if (first) {
						first = false;
						aEntered();
						await aHeld;
					}
					return NOW - 5_000;
				},
			});
		};
		const slow = racer(1_001, true);
		await aInProbe;
		const fast = await racer(1_002, false);
		expect(fast.acquired).toBe(true);
		resumeA();
		const slowResult = await slow;
		expect(slowResult).toMatchObject({ acquired: false, holder: { pid: 1_002 } });
		const onDisk = readLeaseRecord(await readFile(path, "utf8"));
		expect(onDisk).not.toBe("unparseable");
		if (onDisk === "unparseable" || !fast.acquired) return;
		expect(onDisk.token).toBe(fast.token);
	});

	it("writes a v2 record that the legacy v1 reader still parses", async () => {
		const dir = await tempDir();
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
		});
		expect(result.acquired).toBe(true);
		const raw: unknown = JSON.parse(await readFile(join(dir, "s.lease"), "utf8"));
		expect(raw).toMatchObject({
			v: LEASE_RECORD_VERSION,
			pid: process.pid,
			startedAtMs: NOW,
			acquiredAtMs: NOW,
			bootAtMs: BOOT,
			processStartedAtMs: NOW - 5_000,
		});
		const legacyView = raw as { pid: unknown; startedAtMs: unknown; token: unknown };
		expect(typeof legacyView.pid).toBe("number");
		expect(typeof legacyView.startedAtMs).toBe("number");
		expect(typeof legacyView.token).toBe("string");
		expect(currentLeaseToken("s")).toBe(legacyView.token);
	});

	it("reclaims a live-looking pid whose start time does not match (pid reuse)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "s.lease"), JSON.stringify(v2Record()), "utf8");
		const readProcessStartMs = vi.fn(async () => HOLDER_START + 10_000);
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs,
		});
		expect(result.acquired).toBe(true);
		expect(readProcessStartMs).toHaveBeenCalledWith(424_242);
		expect(readLeaseRecord(await readFile(join(dir, "s.lease"), "utf8"))).toMatchObject({ pid: process.pid });
	});

	it("reclaims a pre-boot lease with a dead pid without consulting the start-time probe", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "s.lease"),
			JSON.stringify(v2Record({ bootAtMs: BOOT - BOOT_INSTANT_TOLERANCE_MS - 3_600_000 })),
			"utf8",
		);
		const readProcessStartMs = vi.fn(async () => HOLDER_START);
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: () => false,
			readProcessStartMs,
		});
		expect(result.acquired).toBe(true);
		expect(readProcessStartMs).not.toHaveBeenCalled();
	});

	it("keeps a pre-boot lease whose pid is alive and whose start time is confirmed", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "s.lease"),
			JSON.stringify(v2Record({ bootAtMs: BOOT - BOOT_INSTANT_TOLERANCE_MS - 3_600_000 })),
			"utf8",
		);
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => HOLDER_START + 1_000,
		});
		expect(result).toMatchObject({ acquired: false, holder: { pid: 424_242, startedAtMs: HOLDER_START } });
	});

	it("re-enters its own lease with a fresh token and ignores a stale release", async () => {
		const dir = await tempDir();
		const path = join(dir, "s.lease");
		const previous = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW - 60_000,
			self: selfIdentity(),
		});
		expect(previous.acquired).toBe(true);
		if (!previous.acquired) return;
		const staleToken = previous.token;
		// The previous generation's shutdown started (its token is retired) but never released.
		retireLeaseToken(staleToken);
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => {
				throw new Error("self re-entry must not probe");
			},
		});
		expect(result.acquired).toBe(true);
		const record = readLeaseRecord(await readFile(path, "utf8"));
		expect(record).not.toBe("unparseable");
		if (record === "unparseable") return;
		expect(record.token).not.toBe(staleToken);
		await releaseTerminalLease({ path, pid: process.pid, token: staleToken });
		expect(existsSync(path)).toBe(true);
		await releaseTerminalLease({ path, pid: process.pid, token: record.token });
		expect(existsSync(path)).toBe(false);
	});

	it("treats another live generation of this very process as a live holder, not a re-entry", async () => {
		const dir = await tempDir();
		const probes = {
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async (): Promise<number> => {
				throw new Error("same-pid classification must not probe");
			},
		};
		const sibling = await acquireTerminalLease(probes);
		expect(sibling.acquired).toBe(true);
		const result = await acquireTerminalLease(probes);
		expect(result).toMatchObject({ acquired: false, holder: { pid: process.pid } });
		if (sibling.acquired) await releaseTerminalLease(sibling);
	});

	it("re-enters a same-pid lease whose generation shut down without releasing it", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "s.lease"),
			JSON.stringify(v2Record({ pid: process.pid, token: "generation-that-already-shut-down" })),
			"utf8",
		);
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => {
				throw new Error("same-pid classification must not probe");
			},
		});
		expect(result.acquired).toBe(true);
		if (result.acquired) await releaseTerminalLease(result);
	});

	it("reports a confirmed live foreign holder as attached elsewhere", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "s.lease"), JSON.stringify(v2Record()), "utf8");
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => HOLDER_START + 2_000,
		});
		expect(result).toEqual({
			acquired: false,
			holder: { pid: 424_242, startedAtMs: HOLDER_START, bootAtMs: BOOT },
		});
	});

	it("treats a legacy v1 record by liveness plus start-time confirmation", async () => {
		const dir = await tempDir();
		const path = join(dir, "s.lease");
		await writeFile(path, JSON.stringify({ pid: 424_242, startedAtMs: HOLDER_START }), "utf8");
		const dead = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: () => false,
		});
		expect(dead.acquired).toBe(true);

		await writeFile(path, JSON.stringify({ pid: 424_242, startedAtMs: HOLDER_START }), "utf8");
		const reused = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => HOLDER_START + 60_000,
		});
		expect(reused.acquired).toBe(true);

		await writeFile(path, JSON.stringify({ pid: 424_242, startedAtMs: HOLDER_START }), "utf8");
		const confirmed = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => HOLDER_START,
		});
		expect(confirmed).toEqual({ acquired: false, holder: { pid: 424_242, startedAtMs: HOLDER_START } });
	});

	it("treats an unconfirmable start time (probe returns undefined) as a live holder", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "s.lease"), JSON.stringify(v2Record()), "utf8");
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => undefined,
		});
		expect(result.acquired).toBe(false);
	});
});
