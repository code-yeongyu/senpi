// senpi#5349 / code-yeongyu/oh-my-openagent#12096: eval cells reach a signal through the kill guard in every kernel.
// `pkill`, `kill`, `killall` and `sudo` resolve to recording fakes on PATH, and the protected pid every direct signal
// targets is a sleeper the test owns, so no test here can signal anything else (or elevate) even without the guard.
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { decideKillGuardRequest, KILL_GUARD_MODULE_URL } from "@code-yeongyu/senpi";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import { JavaScriptKernel, type JavaScriptKernelMode } from "../src/kernels/js/context-manager.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { runJavaScriptCell } from "./eval/js-kernel-harness.ts";
import { hasPython3, runCell } from "./py-kernel/fixtures.ts";

const REPORTER = `pkill -f 'paid" 2>/dev/null || echo 1' ; true`;
const TAG = "[senpi:kill-guard]";
const posix = process.platform !== "win32";
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

let fakeBin = "";
let ranLog = "";
const savedPath = process.env.PATH;

beforeAll(async () => {
	fakeBin = await mkdtemp(join(tmpdir(), "senpi-kill-guard-bin-"));
	ranLog = join(fakeBin, "ran.log");
	for (const name of ["pkill", "kill", "killall", "sudo"]) {
		const path = join(fakeBin, name);
		await writeFile(path, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(ranLog)}\n`);
		await chmod(path, 0o755);
	}
	process.env.PATH = `${fakeBin}${delimiter}${savedPath ?? ""}`;
});

afterAll(async () => {
	process.env.PATH = savedPath;
	await rm(fakeBin, { recursive: true, force: true });
});

async function ran(): Promise<string> {
	return await readFile(ranLog, "utf8").catch(() => "");
}

function errorText(result: { ok: boolean; error?: { message: string } }): string {
	return result.ok ? "" : (result.error?.message ?? "");
}

type Sleeper = { readonly pid: number; readonly alive: () => boolean; readonly stop: () => void };

/** A test-owned sleeper in its own process group, made protected by the test; it stands in for pid 1. */
function startSleeper(): Sleeper {
	const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) throw new Error("the sleeper did not start");
	return {
		pid,
		// A signalled sleeper is gone or a zombie until the runner reaps it.
		alive: () => {
			const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
			return stat !== "" && !stat.startsWith("Z");
		},
		stop: () => child.kill("SIGKILL"),
	};
}

describe.runIf(posix)("JavaScript kernel cells (E4, E5, E6, A8)", () => {
	const kernels: readonly { name: string; mode: JavaScriptKernelMode; entry?: URL }[] = [
		{ name: "worker", mode: "worker" },
		{
			name: "inline fallback",
			mode: "inline",
			entry: pathToFileURL(join(process.cwd(), "missing-kill-guard-worker.js")),
		},
	];

	it.each(kernels)(
		"refuses the reporter's command and a protected pid in the $name kernel",
		async ({ mode, entry }) => {
			const sleeper = startSleeper();
			onTestFinished(sleeper.stop);
			// The sleeper is the guard's agent here, so it is protected (R2) without a process-table read.
			const kernel = new JavaScriptKernel({
				sessionId: `kill-guard-${crypto.randomUUID()}`,
				cwd: process.cwd(),
				parallelPoolWidth: 1,
				killGuard: { moduleUrl: KILL_GUARD_MODULE_URL, agentPid: sleeper.pid },
				...(entry === undefined ? {} : { workerEntryUrl: entry }),
			});
			try {
				const shell = await runJavaScriptCell(
					kernel,
					`process.getBuiltinModule("node:child_process").execSync(${JSON.stringify(REPORTER)}); return "ran";`,
					20_000,
				);
				expect(kernel.mode).toBe(mode);
				expect(errorText(shell.result)).toContain(TAG);

				const pid = await runJavaScriptCell(
					kernel,
					`process.kill(${sleeper.pid}, "SIGTERM"); return "sent";`,
					20_000,
				);
				expect(errorText(pid.result)).toContain(TAG);
				expect(sleeper.alive()).toBe(true);

				const narrow = await runJavaScriptCell(kernel, `process.kill(${process.pid}, 0); return "probed";`, 20_000);
				expect(narrow.result.ok).toBe(true);
				expect(await ran()).toBe("");
			} finally {
				await kernel.close();
			}
		},
	);
});

type BunReport = { readonly results: readonly { ok: boolean; value?: string; error?: string }[] };

function bunDriver(cells: readonly string[]): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(new URL("../src/kernels/js/context-manager.ts", import.meta.url).pathname)};`,
		"const [reportPath, moduleUrl] = process.argv.slice(2);",
		'const kernel = new JavaScriptKernel({ sessionId: "kill-guard-bun", cwd: process.cwd(), parallelPoolWidth: 1, killGuard: { moduleUrl, agentPid: process.pid } });',
		"const results = [];",
		`for (const code of ${JSON.stringify(cells)}) {`,
		"  const result = await kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 60_000, onMessage: () => {} });",
		"  results.push(result.ok ? { ok: true, value: result.valueRepr } : { ok: false, error: result.error.message });",
		"}",
		"await kernel.close();",
		"await writeFile(reportPath, JSON.stringify({ results }));",
	].join("\n");
}

async function runBun(cells: readonly string[]): Promise<BunReport> {
	const root = await mkdtemp(join(tmpdir(), "senpi-kill-guard-bun-"));
	try {
		await writeFile(join(root, "driver.ts"), bunDriver(cells));
		const report = join(root, "report.json");
		const run = spawnSync("bun", [join(root, "driver.ts"), report, String(KILL_GUARD_MODULE_URL)], {
			encoding: "utf8",
			cwd: root,
			timeout: 90_000,
		});
		if (run.status !== 0) throw new Error(`bun driver exited ${run.status}: ${run.stderr}`);
		return JSON.parse(await readFile(report, "utf8"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe.runIf(posix && bunAvailable)("JavaScript kernel cells under Bun (E4, C32, C33)", { timeout: 120_000 }, () => {
	it("refuses Bun.$ text, an interpolated empty branch and a timer that fires after the cell", async () => {
		const report = await runBun([
			`await Bun.$\`${REPORTER.replaceAll("`", "\\`")}\`; return "ran";`,
			// oxlint-disable-next-line eslint/no-template-curly-in-string -- literal cell text the kernel interpolates (C33).
			'const p = "a||b"; await Bun.$`pkill -f ${p}`; return "ran";',
			'globalThis.late = new Promise((resolve) => setTimeout(() => { try { Bun.$`pkill -f ".*"`; resolve("ran"); } catch (error) { resolve(String(error)); } }, 0)); return "armed";',
			"return await globalThis.late;",
			'Bun.spawnSync(["pkill", "-f", "a||b"]); return "ran";',
			'await Bun.$`echo fine`.quiet(); return "ok";',
			'const guarded = new Bun.$.Shell(); await guarded`pkill -f ".*"`; return "ran";',
			"const plain = new Bun.$.Shell(); return (await plain`echo fine`.text()).trim();",
		]);

		expect(report.results[0]?.error).toContain(TAG);
		expect(report.results[1]?.error).toContain(TAG);
		expect(report.results[3]?.value).toContain(TAG);
		expect(report.results[4]?.error).toContain(TAG);
		expect(report.results[5]).toEqual({ ok: true, value: JSON.stringify("ok") });
		expect(report.results[6]?.error).toContain(TAG);
		expect(report.results[7]).toEqual({ ok: true, value: JSON.stringify("fine") });
		expect(await ran()).toBe("");
	});
});

describe.runIf(posix && (await hasPython3()))("Python kernel cells (E7, E8, A4, C20b)", () => {
	it("refuses the reporter's command through os.system and subprocess, and os.kill of a protected pid", async () => {
		const sleeper = startSleeper();
		onTestFinished(sleeper.stop);
		const requests: unknown[] = [];
		const bridge = await startBridgeServer({
			onCall: async () => undefined,
			onEmit: async () => undefined,
			onCompletion: async () => undefined,
			onKillGuardCheck: async (request) => {
				requests.push(request);
				// The sleeper is the judge's agent here, so it is protected (R2) without a process-table read.
				return decideKillGuardRequest(request, { agentPid: sleeper.pid, view: () => undefined });
			},
		});
		const kernel = await PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "kill-guard-py",
			cwd: process.cwd(),
			connection: { port: bridge.port, token: bridge.token },
			killGuard: { protectedPids: [1, sleeper.pid, process.pid] },
		});
		try {
			const system = await runCell(kernel, `import os\nos.system(${JSON.stringify(REPORTER)})`);
			expect(errorText(system)).toContain(TAG);
			const popen = await runCell(
				kernel,
				`import subprocess\nsubprocess.run(["sh", "-c", ${JSON.stringify(REPORTER)}])`,
			);
			expect(errorText(popen)).toContain(TAG);
			const signal = await runCell(kernel, `import os, signal\nos.kill(${sleeper.pid}, signal.SIGTERM)`);
			expect(errorText(signal)).toContain(TAG);
			expect(sleeper.alive()).toBe(true);

			const before = requests.length;
			const quiet = await runCell(
				kernel,
				[
					"import os, subprocess",
					'subprocess.run(["echo", "hi"], capture_output=True)',
					"try:",
					'    subprocess.run(["git", "status"], capture_output=True)',
					"except OSError:",
					"    pass",
					"os.kill(os.getpid(), 0)",
					'"quiet"',
				].join("\n"),
			);
			expect(quiet).toMatchObject({ ok: true });
			expect(requests.length).toBe(before);

			// A kill-family command or a shell anywhere in argv, behind any wrapper or path (A4); fakes on PATH or the
			// judge's refusal keep each one from running, and the final empty log proves none ran.
			const argvShapes: readonly (readonly string[])[] = [
				["sudo", "pkill", "-f", "x"],
				["env", "FOO=1", "pkill", "-f", "x"],
				["timeout", "5", "pkill", "-f", "x"],
				["xargs", "-r", "kill"],
				["/bin/sh", "-c", REPORTER],
				["env", "sh", "-c", REPORTER],
				["/usr/bin/env", "bash", "-c", REPORTER],
				["sudo", "-n", "sh", "-c", REPORTER],
				["timeout", "5", "bash", "-c", REPORTER],
				["nice", "sh", "-c", REPORTER],
				["/usr/bin/nice", "-n", "5", "/bin/sh", "-c", REPORTER],
				["nohup", "sh", "-c", REPORTER],
				["xargs", "sh", "-c", REPORTER],
			];
			for (const argv of argvShapes) {
				const sent = requests.length;
				await runCell(
					kernel,
					`import subprocess\ntry:\n    subprocess.run(${JSON.stringify(argv)}, input=b"", capture_output=True)\nexcept PermissionError:\n    pass`,
				);
				expect({ argv, sent: requests.length - sent }).toEqual({ argv, sent: 1 });
			}

			const ownGroup = await runCell(kernel, "import os\nos.killpg(0, 0)\n'own group'");
			expect(ownGroup).toMatchObject({ ok: true });
			expect(await ran()).toBe("");
		} finally {
			await kernel.close();
			await bridge.close();
		}
	});
});
