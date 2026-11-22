import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attestSessionSpawn,
	resolvePidSession,
	type SessionSpawnRecord,
} from "../../../src/core/session-spawn-attestation.ts";

/**
 * senpi#6972: a shared rpc host attests which session spawned each tool process, so a gate can prove the calling
 * session from the kernel's ancestry instead of believing `PI_SESSION_ID`. Protects the storage contract
 * (`<dir>/<pid>.json`) and the resolver a gate trusts: a forged environment, a recycled pid or a record naming another
 * parent must never attribute a process to a session.
 */
const supported = process.platform === "linux" || process.platform === "darwin";

interface Sleeper {
	readonly child: ChildProcess;
	readonly pid: number;
	readonly lines: AsyncIterator<string>;
}

describe.skipIf(!supported)("session spawn attestation (#6972)", () => {
	let dir: string;
	const children: ChildProcess[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "senpi-6972-"));
	});
	afterEach(async () => {
		for (const child of children.splice(0)) {
			const exited = child.exitCode !== null || child.signalCode !== null ? undefined : once(child, "exit");
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// The whole group already exited.
			}
			await exited;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function start(script: string, env: NodeJS.ProcessEnv = process.env): Sleeper {
		const child = spawn("/bin/sh", ["-c", script], { env, detached: true, stdio: ["pipe", "pipe", "inherit"] });
		children.push(child);
		if (child.pid === undefined || child.stdout === null) throw new Error("the test child did not start");
		return { child, pid: child.pid, lines: createInterface({ input: child.stdout })[Symbol.asyncIterator]() };
	}

	async function nextLine(sleeper: Sleeper): Promise<string> {
		const line = await sleeper.lines.next();
		if (line.done === true) throw new Error("the test child closed stdout early");
		return line.value;
	}

	it("attributes each recorded child to its own session, two sessions in one host", async () => {
		const a = start("echo ready; exec sleep 30");
		const b = start("echo ready; exec sleep 30");
		await Promise.all([nextLine(a), nextLine(b)]);
		await attestSessionSpawn("session-a", a.pid, { dir }).recorded;
		await attestSessionSpawn("session-b", b.pid, { dir }).recorded;

		expect(await resolvePidSession(a.pid, { dir })).toMatchObject({
			attested: true,
			sessionId: "session-a",
			attestedPid: a.pid,
			hostPid: process.pid,
		});
		expect(await resolvePidSession(b.pid, { dir })).toMatchObject({ attested: true, sessionId: "session-b" });
	});

	it("does not believe a re-exec that rewrites PI_SESSION_ID", async () => {
		// The image that prints `ready` is the last one: it blocks instead of exec'ing on, so the /proc read below never
		// lands inside an exec, where the kernel shows an empty environ (senpi#7049).
		const forger = start("read _go; exec env PI_SESSION_ID=session-b sh -c 'echo ready; read _hold'", {
			PATH: process.env.PATH,
			PI_SESSION_ID: "session-a",
		});
		await attestSessionSpawn("session-a", forger.pid, { dir }).recorded;
		forger.child.stdin?.write("go\n");
		expect(await nextLine(forger)).toBe("ready");
		if (process.platform === "linux") {
			// The forgery really happened: the kernel's view of the process image now names the other session.
			expect(readFileSync(`/proc/${forger.pid}/environ`, "utf8").split("\0")).toContain("PI_SESSION_ID=session-b");
		}

		expect(await resolvePidSession(forger.pid, { dir })).toMatchObject({
			attested: true,
			sessionId: "session-a",
			attestedPid: forger.pid,
		});
	});

	it("attributes a descendant of a recorded child to that child's session", async () => {
		const shell = start("sleep 30 & echo $!; wait");
		const grandchild = Number(await nextLine(shell));
		await attestSessionSpawn("session-a", shell.pid, { dir }).recorded;

		expect(await resolvePidSession(grandchild, { dir })).toEqual({
			attested: true,
			pid: grandchild,
			sessionId: "session-a",
			attestedPid: shell.pid,
			hostPid: process.pid,
			chain: [grandchild, shell.pid],
		});
	});

	it("does not attribute a live process whose pid a record names with another start time", async () => {
		const reused = start("echo ready; exec sleep 30");
		await nextLine(reused);
		const attestation = attestSessionSpawn("session-a", reused.pid, { dir });
		await attestation.recorded;
		const path = join(dir, `${reused.pid}.json`);
		const record: SessionSpawnRecord = JSON.parse(readFileSync(path, "utf8"));
		// The record of an earlier process that wore this pid: same pid, an older start time.
		writeFileSync(path, JSON.stringify({ ...record, startedAtMs: record.startedAtMs - 60_000 }));

		expect(await resolvePidSession(reused.pid, { dir })).toEqual({
			attested: false,
			pid: reused.pid,
			reason: "no_attested_ancestor",
		});
	});

	it("does not attribute a record that names a host which is not the kernel parent", async () => {
		const orphan = start("echo ready; exec sleep 30");
		await nextLine(orphan);
		await attestSessionSpawn("session-a", orphan.pid, { dir }).recorded;
		const path = join(dir, `${orphan.pid}.json`);
		const record: SessionSpawnRecord = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...record, hostPid: process.ppid }));

		expect(await resolvePidSession(orphan.pid, { dir })).toMatchObject({ attested: false });
	});

	it("never replaces a record that still holds a live process, so another session cannot take it over", async () => {
		const shell = start("echo ready; exec sleep 30");
		await nextLine(shell);
		expect(await attestSessionSpawn("session-a", shell.pid, { dir }).recorded).toBe(true);
		expect(await attestSessionSpawn("session-b", shell.pid, { dir }).recorded).toBe(false);

		expect(await resolvePidSession(shell.pid, { dir })).toMatchObject({ attested: true, sessionId: "session-a" });
	});

	it("a release removes only the record it wrote, never a newer one for the same pid", async () => {
		const sleeper = start("echo ready; exec sleep 30");
		await nextLine(sleeper);
		const attestation = attestSessionSpawn("session-a", sleeper.pid, { dir });
		await attestation.recorded;
		const path = join(dir, `${sleeper.pid}.json`);
		const record: SessionSpawnRecord = JSON.parse(readFileSync(path, "utf8"));
		// What another spawn wrote after this pid was recycled.
		const newer = JSON.stringify({ ...record, sessionId: "session-b", startedAtMs: record.startedAtMs + 60_000 });
		writeFileSync(path, newer);
		await attestation.release();

		expect(readFileSync(path, "utf8")).toBe(newer);
	});

	it.skipIf(process.platform !== "linux")("does not attribute a record from another boot", async () => {
		const sleeper = start("echo ready; exec sleep 30");
		await nextLine(sleeper);
		await attestSessionSpawn("session-a", sleeper.pid, { dir }).recorded;
		const path = join(dir, `${sleeper.pid}.json`);
		const record: SessionSpawnRecord = JSON.parse(readFileSync(path, "utf8"));
		expect(record.bootId).toBe(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
		writeFileSync(path, JSON.stringify({ ...record, bootId: "00000000-0000-0000-0000-000000000000" }));

		expect(await resolvePidSession(sleeper.pid, { dir })).toMatchObject({ attested: false });
	});

	it("removes the record when the child exits, so the dead pid resolves to nothing", async () => {
		const short = start("read _go; exit 0");
		const attestation = attestSessionSpawn("session-a", short.pid, { dir });
		await attestation.recorded;
		const path = join(dir, `${short.pid}.json`);
		expect(existsSync(path)).toBe(true);
		const exited = once(short.child, "exit");
		short.child.stdin?.write("go\n");
		await exited;
		await attestation.release();

		expect(existsSync(path)).toBe(false);
		expect(await resolvePidSession(short.pid, { dir })).toMatchObject({ attested: false });
	});

	it("the session-of-pid command answers from the agent directory's records with a gate-readable exit code", async () => {
		const agentDir = join(dir, "agent");
		const sleeper = start("echo ready; exec sleep 30");
		await nextLine(sleeper);
		await attestSessionSpawn("session-a", sleeper.pid, { dir: join(agentDir, "session-spawns") }).recorded;
		const cli = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), "src", "cli.ts");
		const ask = (pid: number) =>
			new Promise<{ readonly code: number; readonly answer: unknown }>((done, fail) => {
				execFile(
					"bun",
					[cli, "session-of-pid", String(pid), "--json"],
					{
						env: { PATH: process.env.PATH, HOME: dir, PI_OFFLINE: "1", SENPI_CODING_AGENT_DIR: agentDir },
						timeout: 30_000,
					},
					(error, stdout) => {
						if (error !== null && typeof error.code !== "number") fail(error);
						else done({ code: error === null ? 0 : Number(error.code), answer: JSON.parse(stdout) });
					},
				);
			});

		expect(await ask(sleeper.pid)).toEqual({
			code: 0,
			answer: {
				version: 1,
				ok: true,
				attested: true,
				pid: sleeper.pid,
				sessionId: "session-a",
				attestedPid: sleeper.pid,
				hostPid: process.pid,
				chain: [sleeper.pid],
			},
		});
		expect(await ask(process.pid)).toEqual({
			code: 1,
			answer: { version: 1, ok: true, attested: false, pid: process.pid, reason: "no_attested_ancestor" },
		});
	});

	it("answers process_not_found for a pid no process wears and never reads the caller's environment", async () => {
		expect(await resolvePidSession(2 ** 22 + 7, { dir })).toEqual({
			attested: false,
			pid: 2 ** 22 + 7,
			reason: "process_not_found",
		});
		expect(await resolvePidSession(process.pid, { dir })).toEqual({
			attested: false,
			pid: process.pid,
			reason: "no_attested_ancestor",
		});
	});
});
