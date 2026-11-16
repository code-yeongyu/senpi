import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureHost, hostEnsureLockTarget } from "../src/modes/rpc/host-ensure.ts";
import { acquireOwnershipSafeLock, isBusy } from "../src/modes/rpc/ownership-safe-lock.ts";

// The ensure lock's scope, observed through ensureHost itself (senpi#6871, senpi#6874 review). Security contract: the
// endpoint lock is this user's own, it is held before the ensure acts, and the tmpdir reap stays outside it.

const events: string[] = [];
/** The ensure lock of the socket under test; the reapers report whether it is held while they run. */
let watchedLock = "";

// The reapers record, when they run, whether the ensure lock is already held: reaping must happen outside it.
vi.mock("../src/modes/rpc/host-internal-dir-reaper.ts", () => ({
	reapOrphanedInternalHostDirs: async () => {
		events.push(`reaped internal hop dirs, lock ${(await lockIsHeld(watchedLock)) ? "held" : "free"}`);
	},
}));
vi.mock("../src/modes/rpc/host-bind-alias-reaper.ts", () => ({
	reapOrphanedBindAliases: async () => {
		events.push(`reaped bind aliases, lock ${(await lockIsHeld(watchedLock)) ? "held" : "free"}`);
	},
}));

const realUid = process.getuid?.() ?? 0;
const roots: string[] = [];
let savedTmp: string | undefined;

beforeEach(() => {
	savedTmp = process.env.TMPDIR;
	events.length = 0;
	watchedLock = "";
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (savedTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = savedTmp;
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A temp root standing in for the machine's shared `/tmp`, with an agent dir and a socket inside it. */
async function machine(): Promise<{ tmp: string; agentDir: string; socket: string }> {
	const tmp = await mkdtemp(join(tmpdir(), "lock-scope-"));
	roots.push(tmp);
	process.env.TMPDIR = tmp;
	return { tmp, agentDir: join(tmp, "agent"), socket: join(tmp, "agent", "rpc", "rpc.sock") };
}

const STOP = new Error("stop after the lock was observed");

/** Runs ensureHost up to the point it holds its lock, observes it there, and stops before it acts. */
async function observeEnsure(agentDir: string, socket: string, observe: () => Promise<void>): Promise<void> {
	await expect(
		ensureHost({
			agentDir,
			socket,
			_test: {
				afterLockAcquired: async () => {
					await observe();
					throw STOP;
				},
			},
		}),
	).rejects.toBe(STOP);
}

/** Whether another holder has `lockFile` locked. Only a busy lock counts as held: any other failure is surfaced. */
async function lockIsHeld(lockFile: string): Promise<boolean> {
	if (lockFile === "") return false;
	return acquireOwnershipSafeLock(lockFile, { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } }).then(
		async (release) => {
			await release();
			return false;
		},
		(error: unknown) => {
			if (isBusy(error)) return true;
			throw error;
		},
	);
}

describe.skipIf(process.platform === "win32")("ensureHost lock scope (#6871)", () => {
	it("holds this user's endpoint lock before it acts, and reaps the tmpdir before taking it", async () => {
		const { tmp, agentDir, socket } = await machine();
		const lockFile = `${hostEnsureLockTarget(socket)}.lock`;
		watchedLock = lockFile;

		await observeEnsure(agentDir, socket, async () => {
			events.push("lock held");
			expect(await lockIsHeld(lockFile)).toBe(true);
		});

		// Reaping inside the critical section made lock hold time scale with the whole tmpdir and, on win32, with a ~1s
		// process probe per candidate, until a concurrent ensureHost exhausted its lock budget.
		expect(events).toEqual(["reaped internal hop dirs, lock free", "reaped bind aliases, lock free", "lock held"]);
		expect(dirname(lockFile)).toBe(join(tmp, `senpi-rpc-host-locks-${realUid}`));
		const dir = await stat(dirname(lockFile));
		expect({ mode: dir.mode & 0o777, uid: dir.uid }).toEqual({ mode: 0o700, uid: realUid });
		expect(await lockIsHeld(lockFile)).toBe(false);
	});

	it("gives two uids on one machine different lock directories for the same socket", async () => {
		const { tmp, socket } = await machine();
		const targets = [1001, 1002].map((uid) => {
			vi.spyOn(process, "getuid").mockReturnValue(uid);
			return hostEnsureLockTarget(socket);
		});

		expect(targets.map(dirname)).toEqual([
			join(tmp, "senpi-rpc-host-locks-1001"),
			join(tmp, "senpi-rpc-host-locks-1002"),
		]);
		expect(basename(targets[0] ?? "")).toBe(basename(targets[1] ?? ""));
	});

	it("refuses to ensure through a lock directory another uid owns, and writes nothing into it", async () => {
		const { tmp, agentDir, socket } = await machine();
		// This process runs as uid N+1 while the directory at its per-uid name belongs to uid N: another user's directory.
		const runAs = realUid + 1;
		const foreign = join(tmp, `senpi-rpc-host-locks-${runAs}`);
		await mkdir(foreign, { mode: 0o700 });
		vi.spyOn(process, "getuid").mockReturnValue(runAs);

		// A recording afterLockAcquired: it runs only if the ensure ever holds a lock, and lets the ensure go on if so.
		const ensure = ensureHost({
			agentDir,
			socket,
			_test: { afterLockAcquired: async () => void events.push("lock held") },
		});
		await expect(ensure).rejects.toThrow(
			new RegExp(`user_dir_unsafe: .*senpi-rpc-host-locks-${runAs}.*owned by uid ${realUid}`),
		);

		// Refused before anything else: no reap ran and afterLockAcquired was never called, so no lock was ever held.
		expect(events).toEqual([]);
		expect(await readdir(foreign)).toEqual([]);
	});
});
