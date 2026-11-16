import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireHostEnsureLock, hostEnsureLockTarget } from "../../../src/modes/rpc/host-ensure-lock.ts";

// senpi#6871: the endpoint lock directory was `<tmpdir>/senpi-rpc-host-locks`, one directory for every user of a
// Linux machine (tmpdir is `/tmp` for all of them). The first user created it 0755, so a second user's host could
// not create its lock file (`EACCES`), exited, and crash-looped. Each user now gets a directory only it owns:
// `$XDG_RUNTIME_DIR/senpi-rpc-host-locks` when that is usable, else `<tmpdir>/senpi-rpc-host-locks-<uid>` (0700),
// verified without following a symlink. Security contract: the lock directory is private to its user.

const uid = process.getuid?.();
const roots: string[] = [];
let saved: { TMPDIR?: string; XDG_RUNTIME_DIR?: string };

beforeEach(() => {
	saved = { TMPDIR: process.env.TMPDIR, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
	delete process.env.XDG_RUNTIME_DIR;
});

afterEach(async () => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const root of roots.splice(0)) {
		await chmod(root, 0o700).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});

/** A fresh temp root standing in for the machine's shared `/tmp`, made the process's TMPDIR. */
async function sharedTmp(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "e6871-"));
	roots.push(root);
	process.env.TMPDIR = root;
	return root;
}

const socketIn = (root: string) => join(root, "agent", "rpc", "rpc.sock");

async function lockAndRelease(socket: string): Promise<void> {
	const release = await acquireHostEnsureLock(socket, 1_000);
	await release();
}

async function modeAndOwner(path: string): Promise<{ mode: number; uid: number }> {
	const entry = await stat(path);
	return { mode: entry.mode & 0o777, uid: entry.uid };
}

describe.skipIf(process.platform === "win32")("the endpoint lock directory is private to its user (#6871)", () => {
	it("a second user's host takes its lock although another user created the old shared directory first", async () => {
		const tmp = await sharedTmp();
		// What user A's first run leaves behind on a fresh Linux box: the shared directory, which user B cannot write
		// into (modelled with the owner's write bit cleared, which denies B-equivalent access to this process).
		const shared = join(tmp, "senpi-rpc-host-locks");
		await mkdir(shared, { mode: 0o755 });
		await chmod(shared, 0o555);

		await lockAndRelease(socketIn(tmp));

		const lockDir = dirname(hostEnsureLockTarget(socketIn(tmp)));
		expect(lockDir).toBe(join(tmp, `senpi-rpc-host-locks-${uid}`));
		expect(await modeAndOwner(lockDir)).toEqual({ mode: 0o700, uid });
		expect(await readdir(shared)).toEqual([]);
	});

	it("uses $XDG_RUNTIME_DIR when it is a private directory of this user, and the per-uid temp dir otherwise", async () => {
		const tmp = await sharedTmp();
		const runtime = await mkdtemp(join(tmp, "run-"));
		await chmod(runtime, 0o700);
		process.env.XDG_RUNTIME_DIR = runtime;
		await lockAndRelease(socketIn(tmp));
		expect(dirname(hostEnsureLockTarget(socketIn(tmp)))).toBe(join(runtime, "senpi-rpc-host-locks"));
		expect(await modeAndOwner(join(runtime, "senpi-rpc-host-locks"))).toEqual({ mode: 0o700, uid });

		// A runtime dir other users can reach, a relative path and a missing directory are all unusable.
		await chmod(runtime, 0o755);
		for (const unusable of [runtime, "relative/run", join(tmp, "missing")]) {
			process.env.XDG_RUNTIME_DIR = unusable;
			expect(dirname(hostEnsureLockTarget(socketIn(tmp)))).toBe(join(tmp, `senpi-rpc-host-locks-${uid}`));
		}
	});

	it("tightens a per-user directory this user owns but left group/world writable", async () => {
		const tmp = await sharedTmp();
		const lockDir = join(tmp, `senpi-rpc-host-locks-${uid}`);
		await mkdir(lockDir);
		await chmod(lockDir, 0o777);

		await lockAndRelease(socketIn(tmp));

		expect(await modeAndOwner(lockDir)).toEqual({ mode: 0o700, uid });
	});

	it("refuses a symlink planted at the per-user name and writes nothing through it", async () => {
		const tmp = await sharedTmp();
		const elsewhere = await mkdtemp(join(tmp, "planted-"));
		const lockDir = join(tmp, `senpi-rpc-host-locks-${uid}`);
		await symlink(elsewhere, lockDir);

		await expect(lockAndRelease(socketIn(tmp))).rejects.toThrow(/rpc_host_lock_dir_unsafe/);

		expect((await lstat(lockDir)).isSymbolicLink()).toBe(true);
		expect(await readdir(elsewhere)).toEqual([]);
	});
});
