// Temporary Windows probe for senpi#2980 / senpi#3600: loops the Python kernel's live start, cells, reset
// and close inside one CI job and records where a stall happens (stage, CPU use, py-spy stacks).
// Plan via PROBE_PLAN, e.g. "cold=8,warm=30,child=10,vitest=4"; exits 1 when any iteration failed.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { defaultSpawn, type KernelChild } from "../src/kernels/py/process.ts";
import { readKernelCpuTime } from "../src/kernels/shared/process-cpu.ts";

const STALL_MS = Number(process.env.PROBE_STALL_MS ?? 6_000);
const PHASE_CAP_MS = 45_000;
const plan = new Map(
	(process.env.PROBE_PLAN ?? "cold=8,warm=30,child=10,vitest=4")
		.split(",")
		.map((part) => part.split("="))
		.map(([key, value]) => [key ?? "", Number(value ?? 0)] as const),
);

function log(record: Record<string, unknown>): void {
	console.log(`PROBE ${JSON.stringify(record)}`);
}

async function run(command: string, args: readonly string[], timeoutMs = 60_000): Promise<string> {
	return await new Promise((resolve) => {
		const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let out = "";
		child.stdout.on("data", (chunk) => (out += String(chunk)));
		child.stderr.on("data", (chunk) => (out += String(chunk)));
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(`${out.trim()}${code === 0 ? "" : ` [exit ${code}]`}`);
		});
		child.on("error", (error) => resolve(`spawn error: ${error.message}`));
	});
}

interface Tracked {
	readonly children: { readonly pid: number | undefined; readonly spawnedAt: number; exitedAt?: number }[];
	readonly stages: { readonly stage: string; readonly at: number }[];
}

function tracker(): Tracked & { spawnProcess: typeof defaultSpawn } {
	const tracked: Tracked = { children: [], stages: [] };
	return {
		...tracked,
		spawnProcess: (options) => {
			const child: KernelChild = defaultSpawn(options);
			const entry: Tracked["children"][number] = { pid: child.pid, spawnedAt: performance.now() };
			tracked.children.push(entry);
			child.once("exit", () => (entry.exitedAt = performance.now()));
			return child;
		},
	};
}

async function diagnose(pid: number | undefined): Promise<Record<string, unknown>> {
	if (pid === undefined) return { pid };
	const cpu: string[] = [];
	for (let sample = 0; sample < 4; sample += 1) {
		cpu.push(String(readKernelCpuTime(pid)));
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const pyspy = await run("py-spy", ["dump", "--pid", String(pid), ...(process.platform === "win32" ? ["--native"] : [])], 20_000);
	return { pid, cpu, pyspy };
}

/** Awaits one phase; past STALL_MS it captures the live interpreter's CPU and stacks once, without cancelling. */
async function phase<T>(
	name: string,
	phases: Record<string, unknown>,
	livePid: () => number | undefined,
	work: () => Promise<T>,
): Promise<T> {
	const started = performance.now();
	let diag: Promise<Record<string, unknown>> | undefined;
	const watch = setTimeout(() => (diag = diagnose(livePid())), STALL_MS);
	let cap: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work(),
			new Promise<never>((_, reject) => {
				cap = setTimeout(() => reject(new Error(`${name} still pending after ${PHASE_CAP_MS} ms`)), PHASE_CAP_MS);
			}),
		]);
	} finally {
		clearTimeout(watch);
		clearTimeout(cap);
		phases[name] = Math.round(performance.now() - started);
		if (diag) phases[`${name}:stall`] = await diag;
	}
}

/** The sequence of py-kernel.test.ts "persists state across cells and reset clears it". */
async function persistsSequence(experiment: string, iteration: number, interpreterPath: string): Promise<boolean> {
	const tracked = tracker();
	const phases: Record<string, unknown> = {};
	const livePid = () => tracked.children.at(-1)?.pid;
	const cell = (kernel: PythonKernel, code: string) =>
		kernel.run({ cellId: `cell-${crypto.randomUUID()}`, code, timeoutMs: 25_000 });
	let failure: string | undefined;
	let kernel: PythonKernel | undefined;
	try {
		kernel = await phase("start", phases, livePid, () =>
			PythonKernel.start({
				interpreterPath,
				sessionId: `probe-${experiment}-${iteration}`,
				cwd: process.cwd(),
				connection: { port: 1, token: "unused" },
				spawnProcess: tracked.spawnProcess,
				onStartupProgress: (stage) => tracked.stages.push({ stage, at: performance.now() }),
			}),
		);
		const live = kernel;
		const first = await phase("cell1", phases, livePid, () => cell(live, "x = 1"));
		const second = await phase("cell2", phases, livePid, () => cell(live, "x + 1"));
		await phase("reset", phases, livePid, () => live.reset());
		const third = await phase("cell3", phases, livePid, () => cell(live, "'x' in globals()"));
		const wrong = [first, second, third].find((result) => !result.ok);
		if (wrong) failure = `cell failed: ${JSON.stringify(wrong)}`;
		else if (second.ok && second.valueRepr !== "2") failure = `x + 1 gave ${second.valueRepr}`;
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	} finally {
		const open = kernel;
		if (open)
			await phase("close", phases, livePid, () => open.close()).catch((error: unknown) => {
				failure ??= `close: ${String(error)}`;
			});
	}
	const base = tracked.children[0]?.spawnedAt ?? 0;
	log({
		experiment,
		iteration,
		ok: failure === undefined,
		failure,
		phases,
		stages: tracked.stages.map(({ stage, at }) => `${stage}@${Math.round(at - base)}`),
		children: tracked.children.map(({ pid, spawnedAt, exitedAt }) => ({
			pid,
			at: Math.round(spawnedAt - base),
			exit: exitedAt === undefined ? null : Math.round(exitedAt - base),
		})),
	});
	return failure === undefined;
}

async function pairs(count: number, body: (iteration: number) => Promise<boolean>): Promise<number> {
	let failed = 0;
	for (let iteration = 0; iteration < count; iteration += 2) {
		const batch = [iteration, iteration + 1].filter((index) => index < count);
		const results = await Promise.all(batch.map(body));
		failed += results.filter((ok) => !ok).length;
	}
	return failed;
}

/** Copies the interpreter tree without bytecode caches, so every start is a first start for the OS and Python. */
function coldCopy(basePrefix: string, iteration: number): string {
	const target = join(process.env.RUNNER_TEMP ?? tmpdir(), `py-cold-${iteration}`);
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	cpSync(basePrefix, target, {
		recursive: true,
		filter: (source) => !/[\\/](__pycache__|site-packages|test|idlelib|tkinter|tcl|Doc|include)([\\/]|$)/i.test(source.slice(basePrefix.length)),
	});
	return join(target, process.platform === "win32" ? "python.exe" : "bin/python3");
}

const CHILD_CELL = [
	"import subprocess, sys, time",
	"started = time.time()",
	"try:",
	"    subprocess.run([sys.executable, '-c', 'print(1)'], capture_output=True, timeout=10, **KW)",
	"    outcome = f'ok {time.time() - started:.2f}s'",
	"except subprocess.TimeoutExpired:",
	"    outcome = 'TIMEOUT 10s'",
	"outcome",
].join("\n");

async function childExperiment(count: number, interpreterPath: string): Promise<number> {
	const kernel = await PythonKernel.start({
		interpreterPath,
		sessionId: "probe-child",
		cwd: process.cwd(),
		connection: { port: 1, token: "unused" },
	});
	let failed = 0;
	try {
		for (let iteration = 0; iteration < count; iteration += 1) {
			for (const [label, kw] of [["inherit", "{}"], ["devnull", "{'stdin': subprocess.DEVNULL}"]] as const) {
				const result = await kernel.run({
					cellId: `child-${iteration}-${label}`,
					code: `KW = ${kw}\n${CHILD_CELL}`,
					timeoutMs: 25_000,
				});
				const outcome = result.ok ? result.valueRepr : `cell failed: ${result.error.message}`;
				const ok = result.ok && String(outcome).includes("ok");
				if (!ok && label === "inherit") failed += 1;
				log({ experiment: "child2980", iteration, stdin: label, ok, outcome });
			}
		}
	} finally {
		await kernel.close();
	}
	return failed;
}

async function vitestExperiment(count: number): Promise<number> {
	let failed = 0;
	for (let iteration = 0; iteration < count; iteration += 1) {
		const started = performance.now();
		const output = await run(
			"bun",
			["../../scripts/run-tests.mjs", "vitest", "run", "test/py-kernel-startup.test.ts", "test/py-kernel.test.ts", "test/py-kernel-child-error.test.ts"],
			240_000,
		);
		const ok = !output.includes("[exit");
		if (!ok) failed += 1;
		const lines = output.split("\n").filter((line) => /FAIL |Error|Tests |stage/.test(line));
		log({ experiment: "vitest", iteration, ok, ms: Math.round(performance.now() - started), lines: lines.slice(0, 12) });
	}
	return failed;
}

const detected = await createInterpreterDetector().detect("py");
if (!detected.ok) throw new Error("no Python interpreter");
const basePrefix = (await run(detected.path.split(" ")[0] ?? "python", ["-c", "import sys; print(sys.base_prefix)"])).trim();
log({
	facts: {
		platform: process.platform,
		bun: process.versions.bun,
		python: detected.path,
		version: detected.version,
		basePrefix,
		defender:
			process.platform === "win32"
				? await run("powershell", ["-NoProfile", "-Command", "Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled,AMRunningMode | ConvertTo-Json -Compress"])
				: "n/a",
		pyspy:
			process.platform === "win32"
				? await run("python", ["-m", "pip", "install", "--quiet", "py-spy"], 120_000)
				: "not installed off Windows",
	},
});

const summary: Record<string, { readonly runs: number; readonly failed: number }> = {};
const cold = process.platform === "win32" && existsSync(basePrefix) ? (plan.get("cold") ?? 0) : 0;
if (cold > 0) summary.cold = { runs: cold, failed: await pairs(cold, (i) => persistsSequence("cold", i, coldCopy(basePrefix, i))) };
const warm = plan.get("warm") ?? 0;
if (warm > 0) summary.warm = { runs: warm, failed: await pairs(warm, (i) => persistsSequence("warm", i, detected.path)) };
const child = plan.get("child") ?? 0;
if (child > 0) summary.child2980 = { runs: child, failed: await childExperiment(child, detected.path) };
const vitest = plan.get("vitest") ?? 0;
if (vitest > 0) summary.vitest = { runs: vitest, failed: await vitestExperiment(vitest) };
console.log(`PROBE-SUMMARY ${JSON.stringify(summary)}`);
process.exit(Object.values(summary).some((entry) => entry.failed > 0) ? 1 : 0);
