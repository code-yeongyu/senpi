import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSpoolDir, removeSpoolDir } from "../../../src/modes/rpc/compact-spool-dir.ts";
import { sweepRecoveryRoots } from "../../../src/modes/rpc/compact-recovery-cleanup.ts";
import { currentRootOwner } from "../../../src/modes/rpc/compact-root-owner.ts";
import * as identity from "../../../src/utils/process-identity.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { nodeCompactStorageIo } from "../../../src/modes/rpc/compact-storage-io.ts";
import { SessionEventFanout } from "../../../src/modes/rpc/session-event-fanout.ts";

// #4272 S14, X04, RULING-65 and RULING-79: all fixtures live below this run's TMPDIR.
let base = "";
const markerName = ".compact-spool-owner";
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "s14-roots-"));
});
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await rm(base, { recursive: true, force: true });
});

async function root(name: string, kind: "scratch" | "live", owner?: Awaited<ReturnType<typeof currentRootOwner>>) {
	const dir = join(base, name);
	await mkdir(dir, { mode: 0o700 });
	await writeFile(
		join(dir, markerName),
		JSON.stringify({ kind, token: "fixture", owner: owner === undefined ? await currentRootOwner() : owner }),
		{ mode: 0o600 },
	);
	await writeFile(join(dir, "content"), "preserved bytes");
	return dir;
}

it("S14 X04 publishes a complete private lifetime marker atomically and still retires its own root", async () => {
	const dir = join(base, "senpi-current-marker");
	const token = await createSpoolDir(dir);
	const marker = JSON.parse(await readFile(join(dir, markerName), "utf8"));
	expect(marker).toMatchObject({ token, kind: "scratch", owner: { pid: process.pid } });
	expect(marker.owner.bootNonce).toEqual(expect.any(String));
	expect(marker.owner.startTime).toEqual(expect.any(String));
	expect((await lstat(join(dir, markerName))).mode & 0o777).toBe(0o600);
	expect(await readdir(dir)).toEqual([markerName]);
	await removeSpoolDir(dir, token);
});

for (const spool of ["transcript", "settled", "current", "event-leases"]) {
	it(`S14 R79 X04 reclaims a provably dead ${spool} spool, never a live owner's spool`, async () => {
		const owner = await currentRootOwner();
		expect(owner).not.toBeNull();
		const dead = await root(`senpi-${spool}-dead`, "scratch", owner && { ...owner, bootNonce: "prior-boot" });
		const live = await root(`senpi-${spool}-live`, "scratch");
		const result = await sweepRecoveryRoots(base);
		expect(result.removed).toBe(1);
		await expect(lstat(dead)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(live, "content"), "utf8")).toBe("preserved bytes");
	});
}

it("S14 X04 proves same-boot pid loss and pid reuse, but preserves committed live roots", async () => {
	const owner = await currentRootOwner();
	if (!owner) throw new Error("fixture needs a provable POSIX owner");
	await root("senpi-current-gone", "scratch", { ...owner, pid: 2_147_483_647 });
	await root("senpi-settled-reused", "scratch", { ...owner, startTime: "Wed Jan 01 00:00:00 2020 UTC" });
	const committed = await root("senpi-transcript-committed", "live", { ...owner, bootNonce: "prior-boot" });
	expect((await sweepRecoveryRoots(base)).removed).toBe(2);
	expect(await readFile(join(committed, "content"), "utf8")).toBe("preserved bytes");
});

it("S14 R86 reports a live root with a dead owner without reclaiming or following links", async () => {
	const owner = await currentRootOwner();
	if (!owner) throw new Error("fixture needs a provable POSIX owner");
	const dir = await root("senpi-current-orphan-live", "live", { ...owner, bootNonce: "prior-boot" });
	const outside = join(base, "unrelated");
	await writeFile(outside, "x".repeat(65_536));
	const link = join(dir, "link");
	await symlink(outside, link);
	const bytes =
		(await lstat(join(dir, markerName))).size + (await lstat(join(dir, "content"))).size + (await lstat(link)).size;
	const stat = await lstat(dir);
	vi.spyOn(Date, "now").mockReturnValue(stat.mtimeMs + 60_000);
	const result = await sweepRecoveryRoots(base);
	expect(result).toEqual({
		removed: 0,
		unknown: [{ name: "senpi-current-orphan-live", reason: "live_owner_dead", ageMs: 60_000, bytes }],
		failures: [],
	});
	expect(await readFile(join(dir, "content"), "utf8")).toBe("preserved bytes");
	expect((await lstat(link)).isSymbolicLink()).toBe(true);
	expect((await lstat(outside)).size).toBe(65_536);
});

it("S14 X04 preserves unknown, foreign, wide-mode and symlink roots and reports their age and size", async () => {
	const missing = join(base, "senpi-current-missing");
	await mkdir(missing, { mode: 0o700 });
	await writeFile(join(missing, "content"), "unknown bytes");
	const malformed = await root("senpi-settled-malformed", "scratch");
	await writeFile(join(malformed, markerName), "not json");
	const wide = await root("senpi-transcript-wide", "scratch");
	await chmod(wide, 0o755);
	const foreign = await root("senpi-current-foreign", "scratch");
	await writeFile(join(foreign, markerName), JSON.stringify({ foreign: true }));
	const outside = join(base, "unrelated");
	await mkdir(outside);
	await writeFile(join(outside, "content"), "outside bytes");
	await symlink(outside, join(base, "senpi-current-link"));
	const linkedMarker = await root("senpi-settled-marker-link", "scratch");
	await rm(join(linkedMarker, markerName));
	await symlink(join(outside, "content"), join(linkedMarker, markerName));
	const result = await sweepRecoveryRoots(base);
	expect(result.removed).toBe(0);
	expect(result.unknown).toHaveLength(6);
	expect(result.unknown.every((entry) => entry.ageMs >= 0 && entry.bytes !== null && entry.bytes >= 0)).toBe(true);
	expect(result.unknown.find((entry) => entry.name === "senpi-current-missing")?.bytes).toBeGreaterThanOrEqual(13);
	expect(await readFile(join(outside, "content"), "utf8")).toBe("outside bytes");
	for (const dir of [missing, malformed, wide, foreign, linkedMarker])
		expect((await lstat(dir)).isDirectory()).toBe(true);
});

it("S14 X04 treats unreadable liveness as unknown rather than proving death", async () => {
	const dir = await root("senpi-current-uncertain", "scratch");
	vi.spyOn(identity, "readProcessIdentity").mockResolvedValue({
		kind: "error",
		error: new Error("probe unavailable"),
	});
	const result = await sweepRecoveryRoots(base);
	expect(result.removed).toBe(0);
	expect(result.unknown).toHaveLength(1);
	expect(await readFile(join(dir, "content"), "utf8")).toBe("preserved bytes");
});

it("S14 X04 limits reclaim to direct producer children, preserving a nested dead root", async () => {
	const owner = await currentRootOwner();
	if (!owner) throw new Error("fixture needs a provable POSIX owner");
	const dead = { ...owner, bootNonce: "previous-boot" };
	await mkdir(join(base, "unrelated"), { mode: 0o700 });
	const nested = await root("unrelated/senpi-current-nested", "scratch", dead);
	const direct = await root("senpi-current-direct", "scratch", dead);
	expect((await sweepRecoveryRoots(base)).removed).toBe(1);
	await expect(lstat(direct)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(join(nested, "content"), "utf8")).toBe("preserved bytes");
});

it("S14 X04 Windows reports its reasoned no-op before attempting any filesystem traversal", async () => {
	vi.stubGlobal(
		"process",
		new Proxy(process, {
			get: (target, property, receiver) =>
				property === "platform" ? "win32" : Reflect.get(target, property, receiver),
		}),
	);
	expect(await sweepRecoveryRoots(join(base, "does-not-exist"))).toEqual({
		removed: 0,
		unknown: [],
		failures: [],
		skipped: "windows_owner_and_nofollow_unavailable",
	});
});

it("S14 T1 X04 failed root removal retains counted debt and can be retried without a false cleanup receipt", async () => {
	vi.useFakeTimers();
	const dir = join(base, "senpi-current-debt");
	const store = new CompactContentStore({
		dir,
		spillAboveBytes: 0,
		spillTargetBytes: 0,
		io: {
			...nodeCompactStorageIo,
			unlink: async () => {
				throw Object.assign(new Error("unlink denied"), { code: "EACCES" });
			},
		},
	});
	const leaf = store.createLeaf("x".repeat(32_768));
	await store.idle();
	const marker = await readFile(join(dir, markerName), "utf8");
	store.adjust(leaf, -1, 0);
	await store.idle();
	expect(store.status().reclaimDebtBytes).toBe(65_536);
	await writeFile(
		join(dir, markerName),
		JSON.stringify({ kind: "scratch", token: "foreign", owner: await currentRootOwner() }),
	);
	await expect(store.retire()).rejects.toMatchObject({ name: "CompactSpoolRefusedError" });
	expect(store.status().reclaimDebtBytes).toBe(65_536);
	await vi.advanceTimersByTimeAsync(100);
	expect(store.status().reclaimDebtBytes, "a retry timer cannot pretend an undeleted root was reclaimed").toBe(65_536);
	await writeFile(join(dir, markerName), marker);
	await store.retire();
	await expect(lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	expect(store.status().reclaimDebtBytes).toBe(0);
});

it("S14 R79 the actual compact host startup reclaims the dead producer roots in its own base", async () => {
	const owner = await currentRootOwner();
	const dir = await root("senpi-transcript-startup", "scratch", owner && { ...owner, bootNonce: "previous-boot" });
	vi.stubEnv("TMPDIR", base);
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const host = new SessionEventFanout();
	expect((await host.startupCleanup)?.removed).toBe(1);
	await expect(lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("S14 carry 22 orderly retirement during owned background I/O does not invent a storage failure", async () => {
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const store = new CompactContentStore({
		dir: join(base, "senpi-current-held"),
		spillAboveBytes: 0,
		spillTargetBytes: 0,
		io: {
			...nodeCompactStorageIo,
			readFile: async (path) => {
				entered.resolve();
				await finish.promise;
				return nodeCompactStorageIo.readFile(path);
			},
		},
	});
	const leaf = store.createLeaf("held I/O");
	await store.idle();
	store.enqueue("page_write", async () => {
		await store.readLeaf(leaf);
	});
	await entered.promise;
	const retiring = store.retire();
	finish.resolve();
	await retiring;
	expect(store.status().failures).toEqual([]);
});
