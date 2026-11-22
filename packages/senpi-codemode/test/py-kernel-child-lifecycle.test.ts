import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { hasPython3, liveKernel, runCell } from "./py-kernel/fixtures.ts";

const kernelModulePath = fileURLToPath(new URL("../src/kernels/py/kernel.ts", import.meta.url));
const detectorModulePath = fileURLToPath(new URL("../src/interpreters/detect.ts", import.meta.url));
const spawnedPids = new Set<number>();

function track(...pids: number[]): void {
	for (const pid of pids) if (pid > 0) spawnedPids.add(pid);
}

function killAll(pids: readonly number[]): void {
	for (const pid of pids) {
		if (pid > 0) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (process.platform === "win32") return true;
	// A reaped-but-unwaited child stays a zombie; defunct means terminated. `ps -p`
	// exits non-zero (execFileSync throws) once the pid is gone, which is also not running.
	try {
		const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return stat.length > 0 && !stat.startsWith("Z");
	} catch {
		return false;
	}
}

async function pollGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isRunning(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !isRunning(pid);
}

async function readPids(path: string, timeoutMs: number): Promise<readonly [number, number] | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const text = (await readFile(path, "utf8")).trim();
			const match = /^(\d+) (\d+)$/.exec(text);
			if (match) return [Number(match[1]), Number(match[2])];
		} catch {
			/* not written yet */
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return null;
}

function hostLossDriverSource(pidFile: string): string {
	const cell = [
		"import subprocess, sys, os",
		"child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])",
		`open(${JSON.stringify(pidFile)}, 'w').write(str(os.getpid()) + ' ' + str(child.pid))`,
		"while True:",
		"    pass",
	].join("\n");
	return [
		`import { createInterpreterDetector } from ${JSON.stringify(detectorModulePath)};`,
		`import { PythonKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const detected = await createInterpreterDetector().detect('py');",
		"if (!detected.ok) process.exit(3);",
		"const kernel = await PythonKernel.start({ interpreterPath: detected.path, sessionId: 'host-loss', cwd: process.cwd(), connection: { port: 1, token: 'unused' } });",
		// EOF on stdin means whoever started this driver is gone, however it ended: never outlive it.
		"process.stdin.on('end', () => {",
		// A close that hangs must not keep the driver alive either: exit by a deadline regardless.
		"  setTimeout(() => process.exit(1), 5_000).unref();",
		"  void kernel.close().finally(() => process.exit(0));",
		"});",
		"process.stdin.resume();",
		`void kernel.run({ cellId: 'blocking-child', code: ${JSON.stringify(cell)}, timeoutMs: 60_000 });`,
		"await new Promise(() => {});",
	].join("\n");
}

async function readPid(path: string, timeoutMs: number): Promise<number | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const text = (await readFile(path, "utf8")).trim();
			if (/^\d+$/.test(text)) return Number(text);
		} catch {
			/* not written yet */
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return null;
}

// Stands in for the test runner: holds the driver's stdin and is killed without any teardown.
function runnerSource(driverPath: string, driverPidFile: string): string {
	return [
		'import { spawn } from "node:child_process";',
		'import { writeFileSync } from "node:fs";',
		`const driver = spawn("bun", [${JSON.stringify(driverPath)}], { stdio: ["pipe", "ignore", "ignore"] });`,
		`writeFileSync(${JSON.stringify(driverPidFile)}, String(driver.pid));`,
		"await new Promise(() => {});",
	].join("\n");
}

// #1697: a cell's own subprocess is spawned into the kernel's process group; on
// close the leader exited gracefully but its group was never swept.
describe.skipIf(!(await hasPython3()))("PythonKernel retires cell subprocesses on close", () => {
	it("kills a Popen child left running by a cell when the kernel closes", async () => {
		const kernel = await liveKernel();
		const spawned = await runCell(
			kernel,
			"import subprocess, sys\nchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\nchild.pid",
		);
		expect(spawned).toMatchObject({ ok: true, valueRepr: expect.stringMatching(/^\d+$/) });
		if (!spawned.ok || spawned.valueRepr === undefined) throw new Error("child pid was not returned");
		const childPid = Number(spawned.valueRepr);
		expect(isRunning(childPid)).toBe(true);

		await kernel.close();

		const gone = await pollGone(childPid, 2_000);
		if (!gone) {
			try {
				process.kill(childPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		expect(gone).toBe(true);
	});

	// #1697: a cell blocked in the main thread never sees the host's pipe close, so the
	// kernel and its subprocess were orphaned to init when the host died mid-cell.
	it("kills the kernel and its child when the host dies while a cell is blocked", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-py-host-loss-"));
		let driverPid = 0;
		let kernelPid = 0;
		let childPid = 0;
		try {
			const driverPath = join(root, "driver.ts");
			const pidFile = join(root, "pids.txt");
			await writeFile(driverPath, hostLossDriverSource(pidFile), "utf8");
			const driver = spawn("bun", [driverPath], { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
			driverPid = driver.pid ?? 0;
			expect(driverPid).toBeGreaterThan(0);

			const pids = await readPids(pidFile, 15_000);
			expect(pids).not.toBeNull();
			if (!pids) throw new Error("kernel did not report its pids");
			[kernelPid, childPid] = pids;
			track(driverPid, kernelPid, childPid);
			expect(isRunning(kernelPid)).toBe(true);
			expect(isRunning(childPid)).toBe(true);

			process.kill(driverPid, "SIGKILL");

			expect(await pollGone(kernelPid, 6_000)).toBe(true);
			expect(await pollGone(childPid, 6_000)).toBe(true);
		} finally {
			killAll([childPid, kernelPid, driverPid]);
			await rm(root, { recursive: true, force: true });
		}
	});

	// #2562: a driver that only the test's teardown could kill was orphaned for hours when a run ended abnormally.
	it("leaves no driver, kernel or child behind when the process that started the driver dies", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-py-runner-loss-"));
		let runnerPid = 0;
		let driverPid = 0;
		let kernelPid = 0;
		let childPid = 0;
		try {
			const driverPath = join(root, "driver.ts");
			const pidFile = join(root, "pids.txt");
			const driverPidFile = join(root, "driver-pid.txt");
			const runnerPath = join(root, "runner.ts");
			await writeFile(driverPath, hostLossDriverSource(pidFile), "utf8");
			await writeFile(runnerPath, runnerSource(driverPath, driverPidFile), "utf8");
			const runner = spawn("bun", [runnerPath], { cwd: root, stdio: "ignore" });
			runnerPid = runner.pid ?? 0;
			track(runnerPid);

			driverPid = (await readPid(driverPidFile, 15_000)) ?? 0;
			const pids = await readPids(pidFile, 15_000);
			if (!pids || driverPid === 0) throw new Error("driver or kernel did not report its pids");
			[kernelPid, childPid] = pids;
			track(driverPid, kernelPid, childPid);
			expect([driverPid, kernelPid, childPid].map(isRunning)).toEqual([true, true, true]);

			process.kill(runnerPid, "SIGKILL");

			expect(await pollGone(driverPid, 10_000)).toBe(true);
			expect(await pollGone(kernelPid, 6_000)).toBe(true);
			expect(await pollGone(childPid, 6_000)).toBe(true);
		} finally {
			killAll([childPid, kernelPid, driverPid, runnerPid]);
			await rm(root, { recursive: true, force: true });
		}
	});

	afterAll(async () => {
		const survivors: number[] = [];
		for (const pid of spawnedPids) if (!(await pollGone(pid, 2_000))) survivors.push(pid);
		expect(survivors).toEqual([]);
	});
});
