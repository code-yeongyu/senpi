/**
 * Sandboxes for the daemon-directory suites: a temp agent directory, a fixture host, and the
 * teardown that reaps hosts PRODUCTION code spawned detached into them.
 *
 * The per-socket directory name is derived HERE rather than from the code under test, because that
 * is what a client does: the desktop, the CLI and the task runner all recompute it from the socket
 * path alone - its directory realpath-resolved, since the temp dir itself may be a symlink - so a test
 * that asked the implementation where its files went would prove nothing.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { VERSION } from "../../src/config.ts";
import { readProcessStartTime, waitForStartTime } from "../../src/modes/app-server/daemon/process.ts";
import { ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { killAndWait, reapProcessesUnder } from "./spawned-host-reaper.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
const fixture = join(import.meta.dirname, "..", "fixtures", "rpc-host-fixture.mjs");

/** What a host must advertise before any client may attach: protocol capabilities, never a version. */
export const CAPABILITIES = "multi_session,extension_events,session_context,session_kind";
/** What the last release before session kinds advertised - a legacy host, to this build. */
export const LEGACY_CAPABILITIES = "multi_session,extension_events";
/** The published release whose client logic is replayed in the fail-closed proofs. */
export const LEGACY_VERSION = "2026.9.16-3";

export type Sandbox = {
	root: string;
	agentDir: string;
	socket: string;
	flatDir: string;
	daemonDir: string;
	daemonDirName: string;
};

export async function sandbox(label: string, options: { canonicalSocket?: boolean } = {}): Promise<Sandbox> {
	const root = await mkdtemp(join(tmpdir(), `dh-${label}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const socket = options.canonicalSocket ? join(agentDir, "rpc", "rpc.sock") : join(root, "rpc.sock");
	await mkdir(dirname(socket), { recursive: true });
	const flatDir = join(agentDir, "rpc-host-daemon");
	const canonical = join(await realpath(dirname(socket)), basename(socket));
	const daemonDirName = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
	return { root, agentDir, socket, flatDir, daemonDir: join(flatDir, daemonDirName), daemonDirName };
}

/** Kills every host these suites started - including the detached ones `ensureHost` spawned. */
export async function sweepSandboxes(): Promise<void> {
	for (const child of children.splice(0)) await killAndWait(child);
	for (const root of roots.splice(0)) {
		await chmod(root, 0o700).catch(() => undefined);
		await reapProcessesUnder(root);
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

export function ensureFixtureHost(qa: Sandbox) {
	return ensureHost({
		agentDir: qa.agentDir,
		socket: qa.socket,
		_test: {
			spawn: { command: process.execPath, args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"] },
		},
	});
}

/** A detached process this suite owns: a bare sleeper, or the protocol fixture when given its argv. */
export async function spawnDetached(args: readonly string[]): Promise<number> {
	const child = spawn(process.execPath, [...args], { detached: true, stdio: "ignore" });
	children.push(child);
	if (child.pid === undefined) throw new Error("fixture did not spawn");
	await waitForStartTime(child.pid, 2_000);
	return child.pid;
}

export function fixturePath(): string {
	return fixture;
}

export async function startTimeOf(pid: number): Promise<string> {
	const startTime = await readProcessStartTime(pid);
	if (startTime === undefined) throw new Error(`pid ${pid} had no process identity`);
	return startTime;
}

/** Every spawn seam a case that must NOT start a host passes; firing it fails that case. */
export const refuseToSpawn = (): never => {
	throw new Error("a host was spawned when none should have been");
};

export async function readJson(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

export async function permissions(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

/**
 * Waits until the fixture ANSWERS, not merely until its process exists. A case about what an ensure
 * decides from the probe has to start after the probe can succeed, or it silently becomes a case
 * about an unreachable socket.
 */
export async function waitForProtocol(socketPath: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		try {
			await protocolInfo(socketPath);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error(`fixture at ${socketPath} did not answer within ${timeoutMs}ms`);
}

export async function protocolInfo(socketPath: string): Promise<Record<string, unknown>> {
	return new Promise((resolvePromise, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		const timer = setTimeout(() => finish(new Error("protocol timeout")), 1_000);
		const finish = (error?: Error, value?: Record<string, unknown>) => {
			clearTimeout(timer);
			socket.destroy();
			error ? reject(error) : resolvePromise(value!);
		};
		socket.once("connect", () => socket.write('{"id":"probe","type":"get_protocol_info"}\n'));
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline !== -1) finish(undefined, JSON.parse(buffer.slice(0, newline)).data);
		});
		socket.once("error", finish);
	});
}
