// senpi#6132: a failed startup EcoQoS opt-out reaches the brand debug log with its failing step and win32
// error; a successful or skipped start records nothing, so a normal start still prints and logs nothing new.
//
// The first describe pins the recording contract at the sink boundary (fake kernel32, synchronous). The second
// drives the REAL startup module in a child process against a fake kernel32 .dll loaded through bun:ffi on a
// faked win32 platform, and reads the diagnostic from the real debug log under a private temp agent dir — so a
// startup entry that silently drops ensureWindowsPowerThrottlingOptOut()'s result again fails the test.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	installWindowsPowerThrottlingOptOut,
	type Kernel32PowerThrottling,
	type SpawnSurfaces,
} from "./core/windows-power-throttling.ts";
import { recordFailedStartupPowerThrottlingOptOut } from "./windows-power-throttling-startup.ts";

function kernel32(failing: "none" | "open" | "set"): Kernel32PowerThrottling {
	return {
		OpenProcess: () => (failing === "open" ? null : { pid: 99 }),
		SetProcessInformation: () => (failing === "set" ? 0 : 1),
		GetProcessInformation: () => 1,
		CloseHandle: () => 1,
		GetLastError: () => 5,
	};
}

function surfaces(): SpawnSurfaces {
	return { childProcessPrototype: { spawn: () => "unused" } };
}

function installWith(load: () => Kernel32PowerThrottling | undefined) {
	return installWindowsPowerThrottlingOptOut({ platform: "win32", env: {}, pid: 99, load, surfaces: surfaces() });
}

describe("recordFailedStartupPowerThrottlingOptOut", () => {
	it("records the failing step and win32 error of a failed self opt-out (senpi#6132)", () => {
		for (const failing of ["set", "open"] as const) {
			const install = installWith(() => kernel32(failing));
			if (install.status !== "installed") throw new Error("not installed");
			const append = vi.fn();
			recordFailedStartupPowerThrottlingOptOut(install, append);
			expect(append).toHaveBeenCalledTimes(1);
			const [header, text] = append.mock.calls[0] as [string, string];
			expect(header).toBe("windows power throttling opt-out failed");
			expect(text).toContain(failing === "set" ? "step=SetProcessInformation" : "step=OpenProcess");
			expect(text).toContain("win32Error=5");
		}
	});

	it("records nothing on a successful self opt-out", () => {
		const install = installWith(() => kernel32("none"));
		if (install.status !== "installed") throw new Error("not installed");
		expect(install.self).toEqual({ ok: true });
		const append = vi.fn();
		recordFailedStartupPowerThrottlingOptOut(install, append);
		expect(append).not.toHaveBeenCalled();
	});

	it("records nothing on a skipped start (not-windows, opted-out, no-ffi)", () => {
		for (const options of [
			{ platform: "linux" as const, load: () => undefined },
			{ platform: "win32" as const, env: { SENPI_KEEP_POWER_THROTTLING: "1" }, load: () => undefined },
			{ platform: "win32" as const, load: () => undefined },
		]) {
			const install = installWindowsPowerThrottlingOptOut({
				...options,
				surfaces: surfaces(),
				pid: 99,
				env: "env" in options ? options.env : {},
			});
			if (install.status !== "skipped") throw new Error("not skipped");
			const append = vi.fn();
			recordFailedStartupPowerThrottlingOptOut(install, append);
			expect(append).not.toHaveBeenCalled();
		}
	});
});

// -----------------------------------------------------------------------------
// The real startup entry, through the real debug-log sink, in a child process.
// -----------------------------------------------------------------------------

const compiler = (() => {
	for (const candidate of ["cc", "gcc", "clang"]) {
		try {
			if (spawnSync(candidate, ["--version"]).status === 0) return candidate;
		} catch {
			// keep looking
		}
	}
	return undefined;
})();

// The entry children run under Bun (bun:ffi), whichever runner hosts this file, so they also run under vitest.
const bunBinary = process.versions.bun
	? process.execPath
	: spawnSync("bun", ["--version"]).status === 0
		? "bun"
		: undefined;
const entrySkipReason =
	process.platform === "win32"
		? "the real kernel32 path is covered by windows-power-throttling.win32.test.ts"
		: bunBinary === undefined
			? "no Bun runtime for the entry child"
			: compiler === undefined
				? "no C compiler for the fake kernel32"
				: undefined;

const moduleUrl = new URL("./windows-power-throttling-startup.ts", import.meta.url).href;

/** Compiles a fake kernel32 (an ELF named kernel32.dll that bun:ffi dlopen resolves via LD_LIBRARY_PATH). */
function compileFakeKernel32(dir: string, setProcessInformationFails: boolean): string {
	fs.mkdirSync(dir, { recursive: true });
	const source = [
		"#include <stdint.h>",
		"void* OpenProcess(uint32_t a, int32_t b, uint32_t c){(void)a;(void)b;(void)c;return (void*)1;}",
		`int32_t SetProcessInformation(void* p,int32_t c,void* i,uint32_t l){(void)p;(void)c;(void)i;(void)l;return ${setProcessInformationFails ? 0 : 1};}`,
		"int32_t GetProcessInformation(void* p,int32_t c,void* i,uint32_t l){(void)p;(void)c;(void)i;(void)l;return 1;}",
		"int32_t CloseHandle(void* h){(void)h;return 1;}",
		"uint32_t GetLastError(void){return 5;}",
	].join("\n");
	fs.writeFileSync(path.join(dir, "kernel32.c"), source);
	const build = spawnSync(compiler ?? "cc", ["-shared", "-fPIC", "-o", "kernel32.dll", "kernel32.c"], {
		cwd: dir,
		encoding: "utf8",
	});
	if (build.status !== 0) throw new Error(`fake kernel32 build failed: ${build.stderr}`);
	return dir;
}

interface EntryRun {
	code: number;
	logText: string | undefined;
}

/**
 * Runs the actual startup module in a fresh process. With \`fakeWin32\`, the child fakes process.platform and
 * loads the fake kernel32 through LD_LIBRARY_PATH, so the startup self opt-out fails exactly as on Windows. The
 * child resolves its own debug-log path through the real getDebugLogPath under the private temp agent dir.
 */
async function runStartupEntry(
	agentDir: string,
	options: { fakeWin32?: string; keepThrottling?: boolean } = {},
): Promise<EntryRun> {
	const childScript = `
const fakeWin32 = ${JSON.stringify(options.fakeWin32 ?? null)};
const wantEntry = ${options.fakeWin32 !== undefined && options.keepThrottling !== true};
const descriptor = fakeWin32 === null ? undefined : Object.getOwnPropertyDescriptor(process, "platform");
if (descriptor !== undefined) Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
await import(${JSON.stringify(moduleUrl)});
if (descriptor !== undefined) Object.defineProperty(process, "platform", descriptor);
const fs = await import("node:fs");
const { getDebugLogPath } = await import(${JSON.stringify(new URL("./config.ts", import.meta.url).href)});
const log = getDebugLogPath();
console.log("LOG_PATH:" + log);
// The record/no-record decision is synchronous at import, and the record is one appendFileSync inside the
// startup module's import("./core/hidden-stdout-log.ts").then(...). Awaiting the same module here, then one
// macrotask turn, runs that callback first, so the file's presence is decided by event order, not by a wait.
await import(${JSON.stringify(new URL("./core/hidden-stdout-log.ts", import.meta.url).href)});
await new Promise((resolve) => setImmediate(resolve));
// The parent asserts the log contents; the child only fails a start that must not touch the log at all.
process.exit(!wantEntry && fs.existsSync(log) ? 6 : 0);`;
	const child: ChildProcess = spawn(bunBinary as string, ["-e", childScript], {
		env: {
			...process.env,
			SENPI_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_DIR: agentDir,
			LD_LIBRARY_PATH: options.fakeWin32 ?? "",
			...(options.keepThrottling === true ? { SENPI_KEEP_POWER_THROTTLING: "1" } : {}),
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	const [close] = (await once(child, "close")) as [number | null];
	// The log file name is the active brand's APP_NAME + "-debug.log" (observed "pi-debug.log" in a bare child),
	// so the child reports its own resolved path and the parent reads exactly that file.
	const reportedPath = /^LOG_PATH:(.+)$/m.exec(stdout)?.[1];
	let logText: string | undefined;
	if (reportedPath !== undefined && fs.existsSync(reportedPath)) {
		logText = fs.readFileSync(reportedPath, "utf8");
	}
	return { code: close ?? -1, logText };
}

describe.skipIf(entrySkipReason !== undefined)(
	`startup entry through the real debug-log sink${entrySkipReason ? ` (skipped: ${entrySkipReason})` : ""}`,
	() => {
		it("a failed self opt-out at startup records step and win32 error in the brand debug log (senpi#6132)", async () => {
			const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-6132-entry-"));
			try {
				const failingKernel = compileFakeKernel32(path.join(agentDir, "failing-kernel32"), true);
				const run = await runStartupEntry(agentDir, { fakeWin32: failingKernel });
				expect(run.code).toBe(0);
				expect(run.logText).toBeDefined();
				expect(run.logText).toContain("windows power throttling opt-out failed");
				expect(run.logText).toContain("step=SetProcessInformation");
				expect(run.logText).toContain("win32Error=5");
			} finally {
				fs.rmSync(agentDir, { recursive: true, force: true });
			}
		});

		// Review of #7331: a fast exit (--version, engine-free --help) leaves through exitAfterOutput right after startup;
		// the failure entry is written before it exits, exactly once.
		it("a failed opt-out followed by the fast exit still writes exactly one entry", async () => {
			const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-6132-fast-"));
			try {
				const failingKernel = compileFakeKernel32(path.join(agentDir, "failing-kernel32"), true);
				const exitUrl = new URL("./cli/print-then-exit.ts", import.meta.url).href;
				const script = [
					"const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');",
					"Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });",
					`await import(${JSON.stringify(moduleUrl)});`,
					"Object.defineProperty(process, 'platform', descriptor);",
					`const { exitAfterOutput } = await import(${JSON.stringify(exitUrl)});`,
					"await exitAfterOutput('');",
				].join("\n");
				const child = spawnSync(bunBinary as string, ["-e", script], {
					env: {
						...process.env,
						SENPI_CODING_AGENT_DIR: agentDir,
						PI_CODING_AGENT_DIR: agentDir,
						LD_LIBRARY_PATH: failingKernel,
					},
					encoding: "utf8",
				});
				expect(child.status, child.stderr).toBe(0);
				const logs = fs
					.readdirSync(agentDir, { recursive: true })
					.map(String)
					.filter((name) => name.endsWith(".log"));
				const text = logs.map((name) => fs.readFileSync(path.join(agentDir, name), "utf8")).join("");
				expect(text.split("windows power throttling opt-out failed").length - 1).toBe(1);
			} finally {
				fs.rmSync(agentDir, { recursive: true, force: true });
			}
		});

		it("a normal start on this platform writes no debug-log entry", async () => {
			const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-6132-normal-"));
			try {
				const run = await runStartupEntry(agentDir);
				expect(run.code).toBe(0);
				expect(run.logText).toBeUndefined();
			} finally {
				fs.rmSync(agentDir, { recursive: true, force: true });
			}
		});

		it("a successful self opt-out against a succeeding fake kernel32 writes no debug-log entry", async () => {
			const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-6132-success-"));
			try {
				const succeedingKernel = compileFakeKernel32(path.join(agentDir, "succeeding-kernel32"), false);
				const run = await runStartupEntry(agentDir, { fakeWin32: succeedingKernel });
				expect(run.code).toBe(0);
				expect(run.logText).toBeUndefined();
			} finally {
				fs.rmSync(agentDir, { recursive: true, force: true });
			}
		});

		it("SENPI_KEEP_POWER_THROTTLING=1 keeps Windows' default policy and writes no debug-log entry", async () => {
			const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-6132-keep-"));
			try {
				const failingKernel = compileFakeKernel32(path.join(agentDir, "failing-kernel32"), true);
				const run = await runStartupEntry(agentDir, { fakeWin32: failingKernel, keepThrottling: true });
				expect(run.code).toBe(0);
				expect(run.logText).toBeUndefined();
			} finally {
				fs.rmSync(agentDir, { recursive: true, force: true });
			}
		});
	},
);
