// senpi#3600: the Windows live-kernel stall (a cold start that makes no progress, or a test that times out at 30 s)
// never reproduced on demand. On a Windows CI runner each live kernel is watched; one that makes no progress for
// STALL_MS while its interpreter is alive writes one bundle of what it was doing to RUNNER_TEMP. Diagnostics only:
// nothing here changes a verdict, a timeout or the kernel's behaviour.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSpawn, type KernelSpawnProcess } from "../../src/kernels/py/process.ts";
import type { PythonStartupStage } from "../../src/kernels/py/startup.ts";
import { readKernelCpuTime } from "../../src/kernels/shared/process-cpu.ts";

const STALL_MS = 10_000;
const CHECK_EVERY_MS = 1_000;

interface WatchedChild {
	readonly pid: number | undefined;
	readonly spawnedAt: number;
	exitedAt?: number;
}

export interface StallWatch {
	readonly spawnProcess: KernelSpawnProcess;
	readonly onStartupProgress: (stage: PythonStartupStage) => void;
	note(event: string): void;
}

function capture(command: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let out = "";
		child.stdout.on("data", (chunk) => (out += String(chunk)));
		child.stderr.on("data", (chunk) => (out += String(chunk)));
		const timer = setTimeout(() => child.kill(), 20_000);
		child.on("error", (error) => resolve(`unavailable: ${error.message}`));
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(`${out.trim()}${code === 0 ? "" : ` [exit ${code}]`}`);
		});
	});
}

async function cpuSamples(pid: number): Promise<string[]> {
	const samples: string[] = [];
	for (let sample = 0; sample < 4; sample += 1) {
		samples.push(String(readKernelCpuTime(pid)));
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return samples;
}

async function bundle(label: string, events: readonly string[], children: readonly WatchedChild[]): Promise<void> {
	const alive = children.filter((child) => child.exitedAt === undefined && child.pid !== undefined);
	const interpreters = await Promise.all(
		alive.map(async ({ pid }) => ({
			pid,
			cpu: await cpuSamples(pid ?? 0),
			threads: await capture("powershell", [
				"-NoProfile",
				"-Command",
				`(Get-Process -Id ${pid}).Threads | Select-Object Id,ThreadState,WaitReason,TotalProcessorTime | ConvertTo-Json -Compress`,
			]),
			stacks: await capture("py-spy", ["dump", "--native", "--pid", String(pid)]),
		})),
	);
	const report = {
		label,
		stalledForMs: STALL_MS,
		events,
		children,
		interpreters,
		defender: await capture("powershell", [
			"-NoProfile",
			"-Command",
			"Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled,AMRunningMode | ConvertTo-Json -Compress",
		]),
	};
	const directory = join(process.env.RUNNER_TEMP ?? ".", "py-kernel-diagnostics");
	mkdirSync(directory, { recursive: true });
	const file = join(directory, `${label}-${alive[0]?.pid ?? "none"}-${Date.now()}.json`);
	writeFileSync(file, JSON.stringify(report, null, 2));
	console.warn(`[py-kernel stall diagnostics] ${label}: no progress for ${STALL_MS} ms; bundle at ${file}`);
}

/** A watch for one live kernel on a Windows CI runner; `undefined` everywhere else. */
export function watchLiveKernel(label: string): StallWatch | undefined {
	if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") return undefined;
	const started = performance.now();
	const events: string[] = [];
	const children: WatchedChild[] = [];
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
		if (reported || performance.now() - lastProgress < STALL_MS) return;
		reported = true;
		clearInterval(timer);
		void bundle(label, events, children).catch((error: unknown) =>
			console.warn(`[py-kernel stall diagnostics] ${label}: bundle failed: ${String(error)}`),
		);
	}, CHECK_EVERY_MS);
	timer.unref();
	return {
		note,
		onStartupProgress: (stage) => note(`stage ${stage}`),
		spawnProcess: (options) => {
			const child = defaultSpawn(options);
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
