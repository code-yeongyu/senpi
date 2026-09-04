import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireTerminalLease,
	releaseTerminalLease,
} from "../../src/core/extensions/builtin/terminal/manifest-lease.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	for (const dir of createdDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-terminal-lease-"));
	createdDirs.push(dir);
	return dir;
}

function epermProbe(): (pid: number) => boolean {
	return () => {
		const error = new Error("kill EPERM") as NodeJS.ErrnoException;
		error.code = "EPERM";
		throw error;
	};
}

function spawnShortLived(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("true", [], { stdio: "ignore" });
		if (child.pid === undefined) {
			reject(new Error("spawn produced no pid"));
			return;
		}
		const pid = child.pid;
		child.once("error", reject);
		child.once("exit", () => resolve(pid));
	});
}

describe("acquireTerminalLease / releaseTerminalLease", () => {
	it("succeeds on first acquire and writes the caller's pid", async () => {
		const dir = join(await tempDir(), "nested", "leases");
		const leasePath = join(dir, "sess-a.lease");
		const startedAtMs = 1_700_000_000_000;
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "sess-a",
			pid: process.pid,
			now: () => startedAtMs,
		});

		expect(result).toEqual({
			acquired: true,
			path: leasePath,
			pid: process.pid,
		});
		expect(JSON.parse(await readFile(leasePath, "utf8"))).toEqual({
			pid: process.pid,
			startedAtMs,
		});
	});

	it("returns the live holder when a second acquire races an exclusive lease", async () => {
		const dir = await tempDir();
		const startedAtMs = 1_700_000_000_111;
		const first = await acquireTerminalLease({
			dir,
			encodedSessionId: "sess-b",
			pid: process.pid,
			now: () => startedAtMs,
		});
		expect(first.acquired).toBe(true);

		const second = await acquireTerminalLease({
			dir,
			encodedSessionId: "sess-b",
			pid: process.pid + 1,
			now: () => startedAtMs + 1,
		});

		expect(second).toEqual({
			acquired: false,
			holder: { pid: process.pid, startedAtMs },
		});
		expect(JSON.parse(await readFile(join(dir, "sess-b.lease"), "utf8"))).toEqual({
			pid: process.pid,
			startedAtMs,
		});
	});

	it("reclaims a lease file that names a dead pid", async () => {
		const dir = await tempDir();
		const deadPid = await spawnShortLived();
		expect(deadPid).toBeTypeOf("number");
		const leasePath = join(dir, "sess-c.lease");
		await writeFile(leasePath, JSON.stringify({ pid: deadPid, startedAtMs: 10 }), "utf8");

		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "sess-c",
			pid: process.pid,
			now: () => 99,
		});

		expect(result).toEqual({ acquired: true, path: leasePath, pid: process.pid });
		expect(JSON.parse(await readFile(leasePath, "utf8"))).toEqual({
			pid: process.pid,
			startedAtMs: 99,
		});
	});

	it("does not reclaim a live holder whose startedAtMs is 11 minutes old", async () => {
		const dir = await tempDir();
		const startedAtMs = Date.now() - 11 * 60 * 1000;
		const leasePath = join(dir, "sess-d.lease");
		await writeFile(leasePath, JSON.stringify({ pid: process.pid, startedAtMs }), "utf8");

		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "sess-d",
			pid: process.pid + 1,
			now: () => Date.now(),
		});

		expect(result).toEqual({
			acquired: false,
			holder: { pid: process.pid, startedAtMs },
		});
		expect(JSON.parse(await readFile(leasePath, "utf8"))).toEqual({
			pid: process.pid,
			startedAtMs,
		});
	});

	it("treats an injected EPERM liveness probe as alive and does not reclaim", async () => {
		const dir = await tempDir();
		const holderPid = 424_242;
		const startedAtMs = 1_111;
		const leasePath = join(dir, "sess-e.lease");
		await writeFile(leasePath, JSON.stringify({ pid: holderPid, startedAtMs }), "utf8");

		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "sess-e",
			pid: process.pid,
			isProcessAlive: epermProbe(),
		});

		expect(result).toEqual({
			acquired: false,
			holder: { pid: holderPid, startedAtMs },
		});
		expect(JSON.parse(await readFile(leasePath, "utf8"))).toEqual({
			pid: holderPid,
			startedAtMs,
		});
	});

	it("releaseTerminalLease unlinks matching pid and leaves an overwritten holder intact", async () => {
		const dir = await tempDir();
		const leasePath = join(dir, "sess-f.lease");
		const acquired = await acquireTerminalLease({
			dir,
			encodedSessionId: "sess-f",
			pid: process.pid,
			now: () => 50,
		});
		expect(acquired).toEqual({ acquired: true, path: leasePath, pid: process.pid });
		await releaseTerminalLease({ path: leasePath, pid: process.pid });
		expect(existsSync(leasePath)).toBe(false);

		const overwritten = await acquireTerminalLease({
			dir,
			encodedSessionId: "sess-f",
			pid: process.pid,
			now: () => 51,
		});
		expect(overwritten).toEqual({ acquired: true, path: leasePath, pid: process.pid });
		const foreign = { pid: process.pid + 7, startedAtMs: 77 };
		await writeFile(leasePath, JSON.stringify(foreign), "utf8");
		await releaseTerminalLease({ path: leasePath, pid: process.pid });
		expect(JSON.parse(await readFile(leasePath, "utf8"))).toEqual(foreign);
	});

	it("reclaims an unparseable lease file", async () => {
		const dir = await tempDir();
		const leasePath = join(dir, "sess-g.lease");
		await writeFile(leasePath, "not-json{{{", "utf8");

		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "sess-g",
			pid: process.pid,
			now: () => 123,
		});

		expect(result).toEqual({ acquired: true, path: leasePath, pid: process.pid });
		expect(JSON.parse(await readFile(leasePath, "utf8"))).toEqual({
			pid: process.pid,
			startedAtMs: 123,
		});
	});
});
