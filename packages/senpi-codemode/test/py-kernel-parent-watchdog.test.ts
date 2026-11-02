import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasPython3 } from "./py-kernel/fixtures.ts";

const processModulePath = fileURLToPath(new URL("../src/kernels/py/process.ts", import.meta.url));
const preludePath = fileURLToPath(new URL("../src/kernels/py/prelude.py", import.meta.url));

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

async function readPid(path: string, timeoutMs: number): Promise<number | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const pid = Number((await readFile(path, "utf8")).trim());
			if (Number.isInteger(pid) && pid > 0) return pid;
		} catch {
			/* not written yet */
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return null;
}

async function killKernelGroup(kernelPid: number): Promise<void> {
	if (process.platform === "win32") {
		try {
			process.kill(kernelPid, "SIGKILL");
		} catch {
			/* already gone */
		}
		return;
	}
	try {
		process.kill(-kernelPid, "SIGKILL");
	} catch {
		try {
			process.kill(kernelPid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

// The driver spawns the kernel through the production defaultSpawn, starts a busy cell,
// and exits before the interpreter finishes booting — the host is already gone when the
// prelude captures its baseline ppid, so only a parent-pid watchdog can retire the kernel.
function orphanedBusyDriverSource(pidFile: string): string {
	const cell = "import time\ntime.sleep(30)";
	return [
		'import { writeFileSync } from "node:fs";',
		`import { defaultSpawn, splitCommand } from ${JSON.stringify(processModulePath)};`,
		"const [interpreter, prelude] = process.argv.slice(2);",
		"const { command, args } = splitCommand(interpreter);",
		"const child = defaultSpawn({ command, args: [...args, '-u', prelude], cwd: process.cwd(), env: { ...process.env } });",
		`writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
		`child.stdin.write(JSON.stringify({ type: 'run', cellId: 'busy', code: ${JSON.stringify(cell)} }) + '\\n', () => {`,
		"	child.unref();",
		"	process.exit(0);",
		"});",
	].join("\n");
}

// Same throwaway host, but the kernel stays idle: the closed stdin pipe is the only
// retirement signal, which is the pre-existing behavior this change must preserve.
function orphanedIdleDriverSource(pidFile: string): string {
	return [
		'import { writeFileSync } from "node:fs";',
		`import { defaultSpawn, splitCommand } from ${JSON.stringify(processModulePath)};`,
		"const [interpreter, prelude] = process.argv.slice(2);",
		"const { command, args } = splitCommand(interpreter);",
		"const child = defaultSpawn({ command, args: [...args, '-u', prelude], cwd: process.cwd(), env: { ...process.env } });",
		`writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
		"child.stdin.end(() => {",
		"	child.unref();",
		"	process.exit(0);",
		"});",
	].join("\n");
}

interface OrphanedDriverRun {
	readonly root: string;
	readonly kernelPid: number;
	readonly driverPid: number;
}

async function runOrphanedDriver(buildSource: (pidFile: string) => string): Promise<OrphanedDriverRun> {
	const root = await mkdtemp(join(tmpdir(), "senpi-py-parent-watchdog-"));
	const pidFile = join(root, "kernel-pid.txt");
	const driverPath = join(root, "driver.ts");
	await writeFile(driverPath, buildSource(pidFile), "utf8");
	const driver = spawn("bun", [driverPath, "python3", preludePath], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
	// Keep the driver's piped stdio drained so it can never block on a full pipe.
	driver.stdout.resume();
	driver.stderr.resume();
	const driverPid = driver.pid ?? 0;
	const kernelPid = await readPid(pidFile, 15_000);
	if (kernelPid === null) {
		try {
			driver.kill("SIGKILL");
		} catch {
			/* already gone */
		}
		await rm(root, { recursive: true, force: true });
		throw new Error("driver did not report the kernel pid");
	}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 8_000);
		timer.unref?.();
		driver.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	return { root, kernelPid, driverPid };
}

// #1659: a busy kernel whose host died before the prelude captured its baseline ppid is
// reparented without any observable transition, so the ppid watchdog cannot see the loss.
describe.skipIf(
	// Windows spawns the kernel non-detached, so host-loss retirement semantics differ there.
	process.platform === "win32" || !(await hasPython3()),
)("PythonKernel host-loss retirement", () => {
	it("retires a busy kernel whose host exited before it finished booting", async () => {
		const { root, kernelPid } = await runOrphanedDriver(orphanedBusyDriverSource);
		try {
			expect(kernelPid).toBeGreaterThan(0);
			// The busy window is the leak window: the cell sleeps for 30 s while the host
			// is already gone, so the kernel must retire on its own within seconds.
			expect(await pollGone(kernelPid, 3_000), "orphaned busy kernel must retire within 3 s").toBe(true);
		} finally {
			await killKernelGroup(kernelPid);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("still retires an idle kernel through stdin EOF when its host is gone", async () => {
		const { root, kernelPid } = await runOrphanedDriver(orphanedIdleDriverSource);
		try {
			expect(kernelPid).toBeGreaterThan(0);
			expect(await pollGone(kernelPid, 3_000), "idle kernel must still exit on stdin EOF").toBe(true);
		} finally {
			await killKernelGroup(kernelPid);
			await rm(root, { recursive: true, force: true });
		}
	});
});
