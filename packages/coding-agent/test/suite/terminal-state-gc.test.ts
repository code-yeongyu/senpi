import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEASE_RECORD_VERSION } from "../../src/core/extensions/builtin/terminal/manifest-lease.ts";
import { processBootAtMs } from "../../src/core/extensions/builtin/terminal/process-identity.ts";
import { sweepTerminalStateDir } from "../../src/core/extensions/builtin/terminal/terminal-state-gc.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	for (const dir of createdDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-terminal-gc-"));
	createdDirs.push(dir);
	return dir;
}

const BOOT = 1_790_000_000_000;
const NOW = BOOT + 3_600_000;
const LIVE_START = NOW - 120_000;
const DEAD_BOOT_PID = 111_111;
const DEAD_V1_PID = 222_222;
const LIVE_PID = 333_333;
const REUSED_PID = 444_000;
const self = { pid: process.pid, bootAtMs: BOOT, processStartedAtMs: NOW - 5_000 };

const FILES = {
	otherBoot: "other-boot.lease",
	v1Dead: "v1-dead.lease",
	liveForeign: "live-foreign.lease",
	empty: "empty.json",
	nonEmpty: "nonempty.json",
	ownJson: "current.json",
	ownLease: "current.lease",
	garbage: "garbage.json",
} as const;

function v2(pid: number, overrides: { bootAtMs?: number; processStartedAtMs?: number; startedAtMs?: number } = {}) {
	return {
		v: LEASE_RECORD_VERSION,
		token: "t",
		pid,
		startedAtMs: LIVE_START,
		bootAtMs: BOOT,
		processStartedAtMs: LIVE_START,
		acquiredAtMs: LIVE_START,
		...overrides,
	};
}

async function write(dir: string, name: string, body: string): Promise<void> {
	await writeFile(join(dir, name), body, "utf8");
}

describe("terminal state gc", () => {
	it("never deletes a lease another process published while the sweep was probing the stale one", async () => {
		const dir = await tempDir();
		const name = "raced.lease";
		await write(dir, name, JSON.stringify(v2(LIVE_PID, { processStartedAtMs: LIVE_START - 3_600_000 })));
		const fresh = JSON.stringify(v2(444_444, { processStartedAtMs: NOW - 1_000 }));
		const swept = await sweepTerminalStateDir(dir, {
			self,
			keep: new Set(),
			isProcessAlive: () => true,
			// The sweep judges the old record reused; while it probes, another process replaces it.
			readProcessStartMs: async () => {
				await writeFile(join(dir, name), fresh, "utf8");
				return LIVE_START;
			},
		});
		expect(await readFile(join(dir, name), "utf8")).toBe(fresh);
		expect(swept.removedLeases).toBe(0);
	});

	it("keeps a reclaim lock whose holder is alive and removes one whose holder is gone or reused", async () => {
		const dir = await tempDir();
		const lock = (pid: number, processStartedAtMs: number) =>
			JSON.stringify({ pid, bootAtMs: processBootAtMs(), processStartedAtMs });
		await write(dir, "held.lease.lock", lock(LIVE_PID, LIVE_START));
		await write(dir, "orphaned.lease.lock", lock(DEAD_V1_PID, LIVE_START));
		await write(dir, "reused.lease.lock", lock(REUSED_PID, LIVE_START));
		await sweepTerminalStateDir(dir, {
			self,
			keep: new Set(),
			isProcessAlive: (pid) => pid === LIVE_PID || pid === REUSED_PID,
			readProcessStartMs: async (pid) => (pid === REUSED_PID ? LIVE_START + 3_600_000 : LIVE_START),
		});
		expect(existsSync(join(dir, "held.lease.lock"))).toBe(true);
		expect(existsSync(join(dir, "orphaned.lease.lock"))).toBe(false);
		expect(existsSync(join(dir, "reused.lease.lock"))).toBe(false);
	});

	it("removes a temp file abandoned by a crash and keeps one that is being published", async () => {
		const dir = await tempDir();
		await write(dir, "s.lease.1.a.tmp", "{}");
		await write(dir, "s.lease.2.b.tmp", "{}");
		const old = new Date(Date.now() - 60_000);
		await utimes(join(dir, "s.lease.1.a.tmp"), old, old);
		await sweepTerminalStateDir(dir, { self, keep: new Set(), readProcessStartMs: async () => LIVE_START });
		expect(existsSync(join(dir, "s.lease.1.a.tmp"))).toBe(false);
		expect(existsSync(join(dir, "s.lease.2.b.tmp"))).toBe(true);
	});

	it("reclaims dead and empty files, keeps live/self/unparseable json, and bounds the scan", async () => {
		const dir = await tempDir();
		await write(dir, FILES.otherBoot, JSON.stringify(v2(DEAD_BOOT_PID, { bootAtMs: BOOT - 3_600_000 })));
		await write(dir, FILES.v1Dead, JSON.stringify({ pid: DEAD_V1_PID, startedAtMs: LIVE_START }));
		await write(dir, FILES.liveForeign, JSON.stringify(v2(LIVE_PID)));
		await write(
			dir,
			FILES.empty,
			JSON.stringify({ version: 1, sessionId: "x", monitors: [], backgroundSessions: [], updatedAt: 1 }),
		);
		await write(
			dir,
			FILES.nonEmpty,
			JSON.stringify({
				version: 1,
				sessionId: "x",
				monitors: [{ monitorId: "mon_a" }],
				backgroundSessions: [],
				updatedAt: 1,
			}),
		);
		await write(
			dir,
			FILES.ownJson,
			JSON.stringify({ version: 1, sessionId: "me", monitors: [], backgroundSessions: [], updatedAt: 1 }),
		);
		await write(dir, FILES.ownLease, JSON.stringify(v2(self.pid)));
		await write(dir, FILES.garbage, "not json");
		const junk = Array.from({ length: 600 }, (_, index) => `junk-${index}.lease`);
		await Promise.all(junk.map((name) => write(dir, name, "x")));
		const seeded = [...Object.values(FILES), ...junk];
		const result = await sweepTerminalStateDir(dir, {
			self,
			keep: new Set([FILES.ownJson, FILES.ownLease]),
			isProcessAlive: (pid) => pid === LIVE_PID || pid === self.pid,
			readProcessStartMs: async (pid) => (pid === LIVE_PID ? LIVE_START : self.processStartedAtMs),
			readdir: async () => seeded,
		});
		expect(existsSync(join(dir, FILES.otherBoot))).toBe(false);
		expect(existsSync(join(dir, FILES.v1Dead))).toBe(false);
		expect(existsSync(join(dir, FILES.empty))).toBe(false);
		expect(existsSync(join(dir, FILES.liveForeign))).toBe(true);
		expect(existsSync(join(dir, FILES.nonEmpty))).toBe(true);
		expect(existsSync(join(dir, FILES.ownJson))).toBe(true);
		expect(existsSync(join(dir, FILES.ownLease))).toBe(true);
		expect(existsSync(join(dir, FILES.garbage))).toBe(true);
		expect(result.examined).toBeLessThanOrEqual(500);
		expect(result.removedManifests).toBe(1);
		const leaseNames = seeded.filter((name) => name.endsWith(".lease"));
		expect(result.removedLeases).toBe(leaseNames.filter((name) => !existsSync(join(dir, name))).length);
	});

	it("removes a reused pid lease and probes start time once", async () => {
		const dir = await tempDir();
		const pid = 444_444;
		await write(dir, "reused.lease", JSON.stringify(v2(pid)));
		const readProcessStartMs = vi.fn(async () => LIVE_START + 60_000);
		const result = await sweepTerminalStateDir(dir, {
			self,
			keep: new Set(),
			isProcessAlive: (candidate) => candidate === pid,
			readProcessStartMs,
		});
		expect(existsSync(join(dir, "reused.lease"))).toBe(false);
		expect(readProcessStartMs).toHaveBeenCalledTimes(1);
		expect(result.removedLeases).toBe(1);
	});

	it("examines and removes exactly limit entries", async () => {
		const dir = await tempDir();
		const names = Array.from({ length: 10 }, (_, index) => `junk-${index}.lease`);
		await Promise.all(names.map((name) => write(dir, name, "x")));
		const result = await sweepTerminalStateDir(dir, {
			self,
			keep: new Set(),
			limit: 3,
			readdir: async () => names,
		});
		expect(result.examined).toBe(3);
		expect(result.removedLeases).toBe(3);
		expect(names.filter((name) => existsSync(join(dir, name))).length).toBe(7);
	});
});
