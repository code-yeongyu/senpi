import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ failure: undefined as NodeJS.ErrnoException | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const execFile = (...args: unknown[]) => {
		if (args[0] === "ps" && probe.failure) throw probe.failure;
		return Reflect.apply(actual.execFile, undefined, args);
	};
	const custom = Symbol.for("nodejs.util.promisify.custom");
	Object.defineProperty(execFile, custom, { value: Reflect.get(actual.execFile, custom) });
	return { ...actual, execFile };
});

let base = "";
beforeEach(async () => {
	// Each probe failure needs a fresh module-owned self/boot cache, not another test's cached verdict.
	vi.resetModules();
	base = await mkdtemp(join(tmpdir(), "s14-spawn-"));
});
afterEach(async () => {
	probe.failure = undefined;
	await rm(base, { recursive: true, force: true });
});

// #4272 RULING-101b: failure to start ps is UNKNOWN, not a storage failure or proof of another owner's death.
const posixIt = it.skipIf(process.platform === "win32");
for (const code of ["EPERM", "EAGAIN", "ENOENT"]) {
	posixIt(`resolves the current owner as UNKNOWN when ps cannot spawn: ${code}`, async () => {
		probe.failure = Object.assign(new Error(`spawn ps ${code}`), { code, syscall: "spawn ps" });
		const { currentRootOwner } = await import("../../../src/modes/rpc/compact-root-owner.ts");
		await expect(currentRootOwner()).resolves.toBeNull();
	});

	posixIt(`creates its own new spool and keeps spilling when ps cannot spawn: ${code}`, async () => {
		probe.failure = Object.assign(new Error(`spawn ps ${code}`), { code, syscall: "spawn ps" });
		const { createSpoolDir, removeSpoolDir } = await import("../../../src/modes/rpc/compact-spool-dir.ts");
		const { CompactContentStore } = await import("../../../src/modes/rpc/compact-content-store.ts");
		const { RecoveryStorageHealth } = await import("../../../src/modes/rpc/compact-storage-health.ts");
		const dir = join(base, "senpi-current-own");
		const token = await createSpoolDir(dir);
		expect(JSON.parse(await readFile(join(dir, ".compact-spool-owner"), "utf8"))).toMatchObject({
			token,
			owner: null,
		});
		await removeSpoolDir(dir, token);
		const health = new RecoveryStorageHealth(base);
		const store = new CompactContentStore({ dir, health, spillAboveBytes: 0, spillTargetBytes: 0 });
		try {
			store.createLeaf("accepted bytes");
			await store.idle();
			expect(store.status()).toMatchObject({ spillHalted: false, spilledLiveBytes: 28, failures: [] });
			expect(health.needsRecovery).toBe(false);
		} finally {
			await store.retire();
		}
	});

	posixIt(
		`preserves foreign roots and refuses adoption or tokenless cleanup when ps cannot spawn: ${code}`,
		async () => {
			const bootNonce =
				process.platform === "darwin"
					? (await promisify(execFile)("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])).stdout.trim()
					: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
			const owner = { bootNonce, pid: process.pid, startTime: "Wed Jan 01 00:00:00 2020 UTC" };
			for (const [name, identity] of [
				["known", owner],
				["unknown", null],
			] as const) {
				const dir = join(base, `senpi-current-foreign-${name}`);
				await mkdir(dir, { mode: 0o700 });
				await writeFile(
					join(dir, ".compact-spool-owner"),
					JSON.stringify({ kind: "scratch", token: "foreign", owner: identity }),
					{ mode: 0o600 },
				);
				await writeFile(join(dir, "content"), "foreign bytes");
			}
			probe.failure = Object.assign(new Error(`spawn ps ${code}`), { code, syscall: "spawn ps" });
			const { sweepRecoveryRoots } = await import("../../../src/modes/rpc/compact-recovery-cleanup.ts");
			const { createSpoolDir, removeSpoolDir } = await import("../../../src/modes/rpc/compact-spool-dir.ts");
			const result = await sweepRecoveryRoots(base);
			expect(result).toMatchObject({ removed: 0, failures: [] });
			expect(result.unknown.map((root) => root.name).sort()).toEqual([
				"senpi-current-foreign-known",
				"senpi-current-foreign-unknown",
			]);
			for (const root of result.unknown) {
				const dir = join(base, root.name);
				await expect(createSpoolDir(dir)).rejects.toMatchObject({ reason: "pre_existing" });
				await expect(removeSpoolDir(dir, "not-the-foreign-token")).rejects.toMatchObject({
					reason: "marker_missing",
				});
				expect(await readFile(join(dir, "content"), "utf8")).toBe("foreign bytes");
			}
		},
	);
}

posixIt("does not swallow a non-spawn probe exception", async () => {
	const failure = new TypeError("invalid probe configuration");
	probe.failure = failure;
	const { currentRootOwner, rootOwnerState } = await import("../../../src/modes/rpc/compact-root-owner.ts");
	await expect(currentRootOwner()).rejects.toBe(failure);
	const bootNonce =
		process.platform === "darwin"
			? (await promisify(execFile)("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])).stdout.trim()
			: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	await expect(
		rootOwnerState({ bootNonce, pid: process.pid, startTime: "Wed Jan 01 00:00:00 2020 UTC" }),
	).rejects.toBe(failure);
});
