// senpi#5645 (S40 PR 2, design v2.4 C3.2): the hand HOLDS the git-activity lock, not just opens it. A real kernel
// flock is taken through a Bun helper that inherits the lock's open file as fd 3 (a flock belongs to the open file, so the
// lock is the test's own). While a child that inherited the descriptor lives, the stranded-lock sweep's exclusive
// non-blocking probe is refused; once the child exits, it succeeds.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Flock, GIT_ACTIVITY_LOCK_NAME, holdActivityLock } from "../../src/modes/rpc/hand-activity-lock.ts";

const FLOCK_SCRIPT = `
const { dlopen, FFIType, read } = require("bun:ffi");
const darwin = process.platform === "darwin";
const errnoName = darwin ? "__error" : "__errno_location";
const lib = dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
	flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	[errnoName]: { args: [], returns: FFIType.ptr },
});
const rc = lib.symbols.flock(3, Number(process.env.FLOCK_OP));
console.log(JSON.stringify({ rc, errno: rc === 0 ? 0 : read.i32(lib.symbols[errnoName](), 0) }));
`;

const hasBun = spawnSync("bun", ["--version"]).status === 0;

/** A real flock(2) on `fd`'s open file, taken by a Bun helper that inherits it as fd 3. */
const kernelFlock: Flock = (fd, operation) => {
	const result = spawnSync("bun", ["-e", FLOCK_SCRIPT], {
		stdio: ["ignore", "pipe", "pipe", fd],
		env: { ...process.env, FLOCK_OP: String(operation) },
		encoding: "utf8",
	});
	return JSON.parse(result.stdout) as { rc: number; errno: number };
};

const LOCK_EX_NB = 2 | 4;

function probeExclusive(lockFile: string): "busy" | "free" {
	const fd = openSync(lockFile, "r+");
	try {
		return kernelFlock(fd, LOCK_EX_NB).rc === 0 ? "free" : "busy";
	} finally {
		closeSync(fd);
	}
}

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!hasBun || process.platform === "win32")("the hand holds the git-activity lock (senpi#5645)", () => {
	it("refuses the sweep's exclusive probe while a child holding fd 3 lives, and allows it after", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-activity-kernel-"));
		dirs.push(root);
		const repo = join(root, "agents", "a1", "repo");
		const locks = join(root, "agents", "a1", "runtime", "locks");
		await mkdir(repo, { recursive: true });
		await mkdir(locks, { recursive: true });

		const hold = await holdActivityLock(repo, kernelFlock);
		if (hold.fd === undefined) throw new Error("no hold");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "ignore", "ignore", hold.fd],
		});
		children.push(child);
		await hold.release();
		const whileLiving = probeExclusive(join(locks, GIT_ACTIVITY_LOCK_NAME));
		const exited = new Promise((done) => child.once("exit", done));
		child.kill("SIGKILL");
		await exited;
		const afterExit = probeExclusive(join(locks, GIT_ACTIVITY_LOCK_NAME));

		expect([whileLiving, afterExit]).toEqual(["busy", "free"]);
	});
});
