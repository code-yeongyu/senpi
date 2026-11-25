// senpi#3600: the Windows live-kernel stall (a cold start that makes no progress, or a test that times out at 30 s)
// never reproduced on demand. On a Windows CI runner each live kernel is watched; one that makes no progress for
// `stallMs` while its interpreter is alive writes one bundle of what it was doing to RUNNER_TEMP. Diagnostics only:
// nothing here changes a verdict, a timeout or the kernel's behaviour.
import { spawn } from "node:child_process";
import { readlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultSpawn, type KernelSpawnProcess } from "../../src/kernels/py/process.ts";
import type { PythonStartupStage } from "../../src/kernels/py/startup.ts";
import { readKernelCpuTime } from "../../src/kernels/shared/process-cpu.ts";

export interface StallWatchOptions {
	/** How long an alive interpreter may make no progress before the bundle is written. */
	readonly stallMs?: number;
	readonly checkEveryMs?: number;
	/** Watch even off a Windows CI runner (the forced-stall self-test). */
	readonly force?: boolean;
	readonly directory?: string;
}

export interface StallWatch {
	readonly spawnProcess: KernelSpawnProcess;
	readonly onStartupProgress: (stage: PythonStartupStage) => void;
	note(event: string): void;
	/** Settles with the bundle's path once it is written; stays pending while nothing stalls. */
	readonly bundle: Promise<string>;
}

export interface ProbeResult {
	readonly command: string;
	readonly available: boolean;
	readonly exitCode: number | null;
	readonly output: string;
}

interface WatchedChild {
	readonly pid: number | undefined;
	readonly spawnedAt: number;
	exitedAt?: number;
}

export const DEFAULT_DIAGNOSTICS_DIRECTORY = join(process.env.RUNNER_TEMP ?? ".", "py-kernel-diagnostics");

function probe(command: string, args: readonly string[]): Promise<ProbeResult> {
	const line = [command, ...args].join(" ");
	return new Promise((resolve) => {
		const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let output = "";
		child.stdout.on("data", (chunk) => (output += String(chunk)));
		child.stderr.on("data", (chunk) => (output += String(chunk)));
		const timer = setTimeout(() => child.kill(), 20_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({
				command: line,
				available: false,
				exitCode: null,
				output: `${command} not available: ${error.message}`,
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ command: line, available: true, exitCode: code, output: output.trim() });
		});
	});
}

/** What the interpreter holds on fds 0-3: `NUL`, `pipe` or the raw target; read from /proc where there is one. */
function stdioRecord(pid: number): Record<string, string> {
	if (process.platform !== "linux")
		return { unavailable: `fd targets are not readable from outside on ${process.platform}` };
	const record: Record<string, string> = {};
	for (const fd of [0, 1, 2, 3]) {
		try {
			const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
			// libuv's stdio "pipe" is a socketpair on Linux.
			const hostPipe = target.startsWith("pipe:") || target.startsWith("socket:");
			record[`fd${fd}`] = target === "/dev/null" ? "NUL" : hostPipe ? "pipe" : target;
		} catch {
			record[`fd${fd}`] = "absent";
		}
	}
	return record;
}

async function cpuSamples(pid: number): Promise<string[]> {
	const samples: string[] = [];
	for (let sample = 0; sample < 4; sample += 1) {
		samples.push(String(readKernelCpuTime(pid)));
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return samples;
}

async function interpreterState(pid: number) {
	const windows = process.platform === "win32";
	return {
		pid,
		stdio: stdioRecord(pid),
		cpu: await cpuSamples(pid),
		threads: windows
			? await probe("powershell", [
					"-NoProfile",
					"-Command",
					`(Get-Process -Id ${pid}).Threads | Select-Object Id,ThreadState,WaitReason,TotalProcessorTime | ConvertTo-Json -Compress`,
				])
			: await probe("ps", ["-L", "-o", "tid,stat,wchan:32,time", "-p", String(pid)]),
		pyspy: await probe("py-spy", ["dump", ...(windows ? ["--native"] : []), "--pid", String(pid)]),
	};
}

async function writeBundle(
	label: string,
	stallMs: number,
	directory: string,
	events: readonly string[],
	children: readonly WatchedChild[],
): Promise<string> {
	const alive = children.filter((child) => child.exitedAt === undefined && child.pid !== undefined);
	const report = {
		label,
		stalledForMs: stallMs,
		events,
		children,
		interpreters: await Promise.all(alive.map(({ pid }) => interpreterState(pid ?? 0))),
		defender:
			process.platform === "win32"
				? await probe("powershell", [
						"-NoProfile",
						"-Command",
						"Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled,AMRunningMode | ConvertTo-Json -Compress",
					])
				: undefined,
	};
	await mkdir(directory, { recursive: true });
	const file = join(
		directory,
		`${label.replace(/[^\w.-]+/g, "_").slice(0, 80)}-${alive[0]?.pid ?? "none"}-${Date.now()}.json`,
	);
	await writeFile(file, JSON.stringify(report, null, 2));
	console.warn(`[py-kernel stall diagnostics] ${label}: no progress for ${stallMs} ms; bundle at ${file}`);
	return file;
}

/** A watch for one live kernel on a Windows CI runner (or anywhere with `force`); `undefined` everywhere else. */
export function watchLiveKernel(label: string, options: StallWatchOptions = {}): StallWatch | undefined {
	if (options.force !== true && (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true"))
		return undefined;
	const stallMs = options.stallMs ?? 10_000;
	const directory = options.directory ?? DEFAULT_DIAGNOSTICS_DIRECTORY;
	const started = performance.now();
	const events: string[] = [];
	const children: WatchedChild[] = [];
	const written = Promise.withResolvers<string>();
	let lastProgress = started;
	let reported = false;
	const note = (event: string) => {
		lastProgress = performance.now();
		events.push(`${Math.round(lastProgress - started)}ms ${event}`);
	};
	const timer = setInterval(() => {
		const alive = children.some((child) => child.exitedAt === undefined);
		if (!alive) {
			if (children.length > 0) clearInterval(timer);
			return;
		}
		if (reported || performance.now() - lastProgress < stallMs) return;
		reported = true;
		clearInterval(timer);
		writeBundle(label, stallMs, directory, events, children).then(written.resolve, (error: unknown) =>
			console.warn(`[py-kernel stall diagnostics] ${label}: bundle failed: ${String(error)}`),
		);
	}, options.checkEveryMs ?? 1_000);
	timer.unref();
	return {
		note,
		bundle: written.promise,
		onStartupProgress: (stage) => note(`stage ${stage}`),
		spawnProcess: (spawnOptions) => {
			const child = defaultSpawn(spawnOptions);
			const watched: WatchedChild = { pid: child.pid, spawnedAt: Math.round(performance.now() - started) };
			children.push(watched);
			note(`spawn pid ${child.pid}`);
			child.stdout.on("data", () => note("stdout"));
			child.stderr.on("data", () => note("stderr"));
			child.once("exit", (code, signal) => {
				watched.exitedAt = Math.round(performance.now() - started);
				note(`exit pid ${child.pid} ${String(code ?? signal)}`);
			});
			return child;
		},
	};
}
