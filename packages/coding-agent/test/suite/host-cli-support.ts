/**
 * Rig for the `senpi host` suites: a sandbox agent directory, the SOURCE CLI run as a real process,
 * and a teardown that reaps the daemons those runs started.
 *
 * The CLI is spawned rather than called, because the contract under test is a process contract: one
 * JSON line on stdout, diagnostics on stderr, and an exit code that classifies the outcome. The
 * child's environment is built explicitly instead of inherited - it is the input of the
 * environment-scope case, and inheriting the runner's own would make that case meaningless.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeHost } from "../../src/modes/rpc/host-probe.ts";
import { stopHost } from "../../src/modes/rpc/host-stop.ts";
import { reapProcessesUnder, waitForPidGone } from "../helpers/spawned-host-reaper.ts";

const cliEntry = join(import.meta.dirname, "..", "..", "src", "cli.ts");
const sandboxes: HostCliSandbox[] = [];

export interface HostCliSandbox {
	readonly root: string;
	readonly agentDir: string;
	/** Where a launch spec and its extensions live: the directory paths are resolved against. */
	readonly specDir: string;
	/** Short on purpose: `<socket>.next-<gen>` must stay inside the 104-byte sun_path limit. */
	readonly socket: string;
}

export interface HostCliResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export async function hostCliSandbox(label: string): Promise<HostCliSandbox> {
	const root = await mkdtemp(join(tmpdir(), `hc-${label}-`));
	const sandbox = { root, agentDir: join(root, "a"), specDir: join(root, "spec"), socket: join(root, "r.sock") };
	sandboxes.push(sandbox);
	await mkdir(sandbox.agentDir, { recursive: true });
	await mkdir(sandbox.specDir, { recursive: true });
	return sandbox;
}

/**
 * Ends every daemon these cases started, then removes their sandboxes.
 *
 * The stop comes FIRST and is waited for: a supervisor that is SIGKILLed - which is all the argv
 * sweep can do - never removes the private hop directory it created under the temp dir, and nothing
 * else ever will. The sweep stays as the backstop for a daemon no registration can prove.
 */
export async function sweepHostCliSandboxes(): Promise<void> {
	for (const sandbox of sandboxes.splice(0)) {
		const stopped = await stopHost({ socket: sandbox.socket, agentDir: sandbox.agentDir, force: true }).catch(
			() => undefined,
		);
		if (stopped?.action === "stopped") await waitForPidGone(stopped.pid, 30_000);
		await reapProcessesUnder(sandbox.root);
		await rm(sandbox.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

/** Runs `senpi host <args>` from source and returns what the process said. */
export function runHostCli(
	sandbox: HostCliSandbox,
	args: readonly string[],
	extraEnv: Readonly<Record<string, string>> = {},
): Promise<HostCliResult> {
	const child = spawn(process.execPath, [cliEntry, "host", ...args, "--socket", sandbox.socket], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
			...systemEnvironment(),
			SENPI_CODING_AGENT_DIR: sandbox.agentDir,
			SENPI_RUNTIME: "bun",
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
	});
}

/**
 * win32 wiring the SPAWNED CLI itself cannot run without (its runtime resolves `SystemRoot` before
 * any of this code runs). Listed here rather than taken from the production allowlist, so the input
 * of the environment-scope case stays independent of the rule that case is about.
 */
function systemEnvironment(): Record<string, string> {
	if (process.platform !== "win32") return {};
	const names = [
		"SystemRoot",
		"SystemDrive",
		"windir",
		"ComSpec",
		"PATHEXT",
		"TEMP",
		"TMP",
		"USERPROFILE",
		"APPDATA",
		"LOCALAPPDATA",
	];
	return Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
}

/** The one JSON line the CLI contract promises: exactly one, and nothing else on stdout. */
export function onlyJsonLine(result: HostCliResult): Record<string, unknown> {
	const lines = result.stdout.split("\n").filter((line) => line.length > 0);
	if (lines.length !== 1) {
		throw new Error(`expected exactly one stdout line, got ${lines.length}: ${JSON.stringify(result.stdout)}`);
	}
	return JSON.parse(lines[0]) as Record<string, unknown>;
}

/**
 * The environment a running process actually holds, read from the OS: `/proc/<pid>/environ` where it
 * exists, and `ps -Eww` where it does not. Reading the daemon itself is what proves the scope,
 * rather than trusting the call that built it.
 */
export function daemonEnvironmentText(pid: number): string {
	if (process.platform === "linux") {
		return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").join("\n");
	}
	return execFileSync("ps", ["-Eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
}

/** Starts a fixture host on the sandbox socket and waits until it ANSWERS, not merely until it exists. */
export async function startFixtureHost(
	sandbox: HostCliSandbox,
	version: string,
	capabilities: string,
): Promise<number> {
	const fixture = join(import.meta.dirname, "..", "fixtures", "rpc-host-fixture.mjs");
	const child = spawn(process.execPath, [fixture, sandbox.socket, version, capabilities, "answer"], {
		detached: true,
		stdio: "ignore",
	});
	if (child.pid === undefined) throw new Error("fixture host did not spawn");
	child.unref();
	await awaitAnswer(sandbox.socket);
	return child.pid;
}

async function awaitAnswer(socket: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (await probeHost({ socket, timeoutMs: 1_000 })) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`no host answered on ${socket} within ${timeoutMs}ms`);
}
