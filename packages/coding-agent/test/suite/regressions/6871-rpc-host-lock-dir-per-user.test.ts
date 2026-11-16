import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireHostEnsureLock, hostEnsureLockTarget } from "../../../src/modes/rpc/host-ensure-lock.ts";

// senpi#6871: the endpoint lock directory was `<tmpdir>/senpi-rpc-host-locks`, one directory for every user of a
// Linux machine (tmpdir is `/tmp` for all of them). The first user created it 0755, so a second user's host could
// not create its lock file (`EACCES`), exited, and crash-looped. Each user now gets `<tmpdir>/senpi-rpc-host-locks-<uid>`
// (0700), verified without following a symlink, whatever XDG_RUNTIME_DIR says. Security contract: the lock directory is
// private to its user, and every process of that user agrees on it.

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

	// Review M1: the directory must not depend on per-session environment. A login shell has XDG_RUNTIME_DIR, cron,
	// `sudo -u`, `docker exec` and nohup'd jobs often do not, and the runtime dir goes away at logout; two processes of
	// one user that resolved different directories would both hold "the" exclusive ensure lock for one socket.
	it("two processes of one user with different XDG_RUNTIME_DIR exclude each other on one socket", async () => {
		const tmp = await sharedTmp();
		const loginRuntime = await mkdtemp(join(tmp, "run-login-"));
		await chmod(loginRuntime, 0o700);
		const socket = socketIn(tmp);

		process.env.XDG_RUNTIME_DIR = loginRuntime;
		const held = await acquireHostEnsureLock(socket, 1_000);
		try {
			delete process.env.XDG_RUNTIME_DIR;
			await expect(acquireHostEnsureLock(socket, 200)).rejects.toThrow(/busy|locked/i);
		} finally {
			await held();
		}
		expect(dirname(hostEnsureLockTarget(socket))).toBe(join(tmp, `senpi-rpc-host-locks-${uid}`));
	});

	// Review L3: a directory other users could WRITE may already hold entries they planted (a symlink named like a
	// lock file), which later opens follow; tightening its mode would not remove them, so it is refused. One they
	// could only read or traverse cannot hold anything of theirs and is tightened.
	it("refuses a per-user directory others could write into, and tightens one they could only read", async () => {
		const tmp = await sharedTmp();
		const lockDir = join(tmp, `senpi-rpc-host-locks-${uid}`);
		await mkdir(lockDir);
		for (const mode of [0o777, 0o770, 0o703]) {
			await chmod(lockDir, mode);
			await expect(lockAndRelease(socketIn(tmp))).rejects.toThrow(/user_dir_unsafe.*writable by group or others/);
			expect((await modeAndOwner(lockDir)).mode).toBe(mode);
			expect(await readdir(lockDir)).toEqual([]);
		}

		await chmod(lockDir, 0o755);
		await lockAndRelease(socketIn(tmp));
		expect(await modeAndOwner(lockDir)).toEqual({ mode: 0o700, uid });
	});

	it("refuses a symlink planted at the per-user name and writes nothing through it", async () => {
		const tmp = await sharedTmp();
		const elsewhere = await mkdtemp(join(tmp, "planted-"));
		const lockDir = join(tmp, `senpi-rpc-host-locks-${uid}`);
		await symlink(elsewhere, lockDir);

		await expect(lockAndRelease(socketIn(tmp))).rejects.toThrow(/user_dir_unsafe/);

		expect((await lstat(lockDir)).isSymbolicLink()).toBe(true);
		expect(await readdir(elsewhere)).toEqual([]);
	});
});
