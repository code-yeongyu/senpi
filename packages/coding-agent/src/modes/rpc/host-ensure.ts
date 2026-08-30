import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as properLockfile from "proper-lockfile";
import { ENV_AGENT_DIR, getAgentDir, isBunBinary, VERSION } from "../../config.ts";
import {
	type DaemonPidFile,
	parseDaemonPidFile,
	processMatchesPidFile,
	waitForStartTime,
} from "../app-server/daemon/process.ts";
import {
	CUSTOM_UNSUPPORTED_CAPABILITY,
	EXTENSION_EVENTS_CAPABILITY,
	RPC_CLIENT_CAPABILITIES_ENV,
} from "./custom-capability.ts";
import {
	DEFAULT_HOST_IDLE_EXIT_MS,
	type HostColdStart,
	type HostLifecyclePolicyInput,
	INTERNAL_SUPERVISOR_FLAG,
} from "./host-lifecycle.ts";

export type { HostColdStart, HostLifecyclePolicyInput };

export interface HostDaemonPaths {
	readonly dir: string;
	readonly pidFile: string;
	readonly lockFile: string;
	readonly settingsFile: string;
	readonly stderrLog: string;
}

export interface EnsureHostOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Host lifecycle policy recorded in settings.json (env overrides win at runtime). */
	readonly policy?: HostLifecyclePolicyInput;
	readonly _test?: {
		readonly readinessTimeoutMs?: number;
		readonly stopTimeoutMs?: number;
		readonly spawn?: { readonly command: string; readonly args: readonly string[] };
		/** Extra env merged over process.env for the spawned host (hermetic test/QA wiring). */
		readonly env?: Readonly<Record<string, string>>;
		/** Extra CLI args forwarded through the supervisor to the host process. */
		readonly hostArgs?: readonly string[];
		/** Runs after endpoint ownership is locked; deterministic concurrency-test gate. */
		readonly afterLockAcquired?: () => Promise<void>;
	};
}

export interface EnsuredHost {
	readonly pid: number;
	readonly socket: string;
	readonly reused: boolean;
}

type ProtocolInfo = {
	readonly serverVersion: string;
	readonly capabilities: readonly string[];
};

const lockOptions = { stale: 60_000, retries: { retries: 100, minTimeout: 20, maxTimeout: 100 } } as const;
const REQUIRED_CAPABILITIES = ["multi_session", EXTENSION_EVENTS_CAPABILITY] as const;
/**
 * Every ensured host starts with this installation-wide profile, independent of
 * the first caller. In particular, extension_events must remain available when
 * a terminal client starts the shared host before the desktop connects.
 */
export const PINNED_HOST_CLIENT_CAPABILITIES = [EXTENSION_EVENTS_CAPABILITY, CUSTOM_UNSUPPORTED_CAPABILITY] as const;

export function createHostDaemonPaths(agentDir = getAgentDir()): HostDaemonPaths {
	const dir = join(agentDir, "rpc-host-daemon");
	return {
		dir,
		pidFile: join(dir, "host.pid"),
		lockFile: join(dir, "daemon.lock"),
		settingsFile: join(dir, "settings.json"),
		stderrLog: join(dir, "stderr.log"),
	};
}

export async function ensureHost(options: EnsureHostOptions): Promise<EnsuredHost> {
	const socket = normalizeSocketPath(options.socket);
	const paths = createHostDaemonPaths(options.agentDir);
	await mkdir(paths.dir, { recursive: true });
	// The public socket is the shared resource; agent directories are not a
	// sufficient lock scope when two installations target the same endpoint.
	const lockTarget = join(tmpdir(), "senpi-rpc-host-locks", createSocketLockName(socket));
	await mkdir(dirname(lockTarget), { recursive: true });
	await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
	const release = await properLockfile.lock(lockTarget, { ...lockOptions, lockfilePath: `${lockTarget}.lock` });
	try {
		await options._test?.afterLockAcquired?.();
		return await ensureHostLocked(paths, socket, options.agentDir ?? getAgentDir(), options.policy, options._test);
	} finally {
		await release();
	}
}

async function ensureHostLocked(
	paths: HostDaemonPaths,
	socket: string,
	agentDir: string,
	policy: HostLifecyclePolicyInput | undefined,
	testOptions: EnsureHostOptions["_test"],
): Promise<EnsuredHost> {
	const pidFile = await readPidFile(paths);
	const protocol = await probeProtocolInfo(socket, 1_000);
	const pidMatches = pidFile ? await processMatchesPidFile(pidFile) : false;
	if (isCompatible(protocol)) {
		// A compatible socket is attachable even when another client surface
		// started it. Only hosts we spawned are eligible for lifecycle management.
		return { pid: pidFile?.pid ?? 0, socket, reused: true };
	}
	if (protocol && !pidMatches) {
		throw new Error(`RPC socket ${socket} is owned by an unmanaged host`);
	}
	if (pidFile && pidMatches) {
		await stopManagedHost(pidFile, testOptions?.stopTimeoutMs ?? 10_000);
	}
	await cleanupState(paths);
	return startHost(paths, socket, agentDir, policy, testOptions);
}

async function startHost(
	paths: HostDaemonPaths,
	socket: string,
	agentDir: string,
	policy: HostLifecyclePolicyInput | undefined,
	testOptions: EnsureHostOptions["_test"],
): Promise<EnsuredHost> {
	// The settings file must exist before the supervisor reads it at boot, so it
	// records the policy before the spawn instead of beside the pidfile.
	await writeFile(
		paths.settingsFile,
		`${JSON.stringify({
			socket,
			capabilities: PINNED_HOST_CLIENT_CAPABILITIES,
			coldStart: policy?.coldStart ?? "transient",
			idleExitMs: policy?.idleExitMs ?? DEFAULT_HOST_IDLE_EXIT_MS,
		})}\n`,
		{ mode: 0o600 },
	);
	const stderr = await open(paths.stderrLog, "w", 0o600);
	let pidFile: DaemonPidFile | undefined;
	try {
		const launch = testOptions?.spawn ?? defaultHostLaunch(socket, testOptions?.hostArgs ?? []);
		const child = spawn(launch.command, [...launch.args], {
			detached: true,
			env: {
				...process.env,
				...(testOptions?.env ?? {}),
				[ENV_AGENT_DIR]: agentDir,
				[RPC_CLIENT_CAPABILITIES_ENV]: PINNED_HOST_CLIENT_CAPABILITIES.join(","),
			},
			stdio: ["ignore", "ignore", stderr.fd],
		});
		child.unref();
		if (child.pid === undefined) throw new Error("failed to spawn RPC socket host");
		pidFile = { pid: child.pid, processStartTime: await waitForStartTime(child.pid, 2_000) };
		await writeFile(paths.pidFile, `${JSON.stringify(pidFile)}\n`, { mode: 0o600 });
	} finally {
		await stderr.close();
	}
	const readinessTimeoutMs = testOptions?.readinessTimeoutMs ?? 10_000;
	const protocol = await pollProtocolInfo(socket, readinessTimeoutMs);
	if (isCompatible(protocol)) return { pid: pidFile.pid, socket, reused: false };
	await stopManagedHost(pidFile, testOptions?.stopTimeoutMs ?? 10_000);
	const diagnostic = await appendStderr(
		paths,
		`spawned RPC socket host did not answer get_protocol_info within ${readinessTimeoutMs}ms`,
	);
	await cleanupState(paths);
	// The supervisor may have failed before binding, or another owner may have
	// appeared while readiness was being checked. Never unlink an endpoint we
	// cannot prove this start owned.
	throw new Error(diagnostic);
}

async function stopManagedHost(pidFile: DaemonPidFile, termTimeoutMs: number): Promise<void> {
	await signalValidated(pidFile, "SIGTERM");
	if (await waitForGone(pidFile, termTimeoutMs)) return;
	await signalValidated(pidFile, "SIGKILL");
	if (!(await waitForGone(pidFile, 2_000))) {
		throw new Error(`RPC socket host pid ${pidFile.pid} remained alive after SIGKILL`);
	}
}

async function signalValidated(pidFile: DaemonPidFile, signal: NodeJS.Signals): Promise<void> {
	if (!(await processMatchesPidFile(pidFile))) return;
	try {
		process.kill(pidFile.pid, signal);
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "ESRCH")) throw error;
	}
}

async function waitForGone(pidFile: DaemonPidFile, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (!(await processMatchesPidFile(pidFile))) return true;
		await delay(50);
	}
	return false;
}

async function pollProtocolInfo(socket: string, timeoutMs: number): Promise<ProtocolInfo | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const info = await probeProtocolInfo(socket, Math.min(500, Math.max(1, deadline - Date.now())));
		if (info) return info;
		await delay(50);
	}
	return undefined;
}

function probeProtocolInfo(socketPath: string, timeoutMs: number): Promise<ProtocolInfo | undefined> {
	return new Promise((resolveProbe) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		let settled = false;
		const finish = (value?: ProtocolInfo): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			resolveProbe(value);
		};
		const timeout = setTimeout(() => finish(), timeoutMs);
		socket.once("connect", () => {
			socket.write('{"id":"ensure-host-probe","type":"get_protocol_info"}\n');
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			finish(readProtocolInfo(buffer.slice(0, newline)));
		});
		socket.once("error", () => finish());
		socket.once("close", () => finish());
	});
}

function readProtocolInfo(text: string): ProtocolInfo | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.id !== "ensure-host-probe" || parsed.success !== true || !isRecord(parsed.data)) {
		return undefined;
	}
	const { serverVersion, capabilities } = parsed.data;
	if (typeof serverVersion !== "string" || !Array.isArray(capabilities)) return undefined;
	if (!capabilities.every((capability) => typeof capability === "string")) return undefined;
	return { serverVersion, capabilities };
}

function isCompatible(protocol: ProtocolInfo | undefined): boolean {
	return (
		protocol?.serverVersion === VERSION &&
		REQUIRED_CAPABILITIES.every((capability) => protocol.capabilities.includes(capability))
	);
}

async function readPidFile(paths: HostDaemonPaths): Promise<DaemonPidFile | undefined> {
	try {
		return parseDaemonPidFile(await readFile(paths.pidFile, "utf8"));
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

async function cleanupState(paths: HostDaemonPaths): Promise<void> {
	await rm(paths.pidFile, { force: true });
	await rm(paths.settingsFile, { force: true });
}

async function appendStderr(paths: HostDaemonPaths, message: string): Promise<string> {
	try {
		const stderr = (await readFile(paths.stderrLog, "utf8")).trim();
		return stderr ? `${message}\n${stderr}` : message;
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return message;
		throw error;
	}
}

function createSocketLockName(socket: string): string {
	return createHash("sha256").update(socket).digest("hex").slice(0, 32);
}

function normalizeSocketPath(value: string): string {
	if (value.startsWith("unix://")) return value.slice("unix://".length);
	return value;
}

/**
 * Default launch: the host-lifecycle supervisor owns the public socket and the
 * idle-exit policy; it spawns the committed RPC socket host itself. Any extra
 * hostArgs are forwarded verbatim to the host CLI (e.g. provider pinning).
 *
 * A compiled standalone binary cannot re-enter itself through a script path:
 * bun executables always boot their embedded entrypoint and parse the whole
 * argv as CLI arguments, so `host-lifecycle.ts --socket <path>` dies with
 * "Unknown option: --socket" before the host ever answers get_protocol_info.
 * Compiled binaries therefore re-enter through the hidden
 * `--internal-rpc-host-supervisor` route that main() dispatches before
 * argument parsing. Exported for tests.
 */
export function defaultHostLaunch(
	socket: string,
	hostArgs: readonly string[],
	compiled: boolean = isBunBinary,
): {
	command: string;
	args: string[];
} {
	if (compiled) {
		return {
			command: process.execPath,
			args: [INTERNAL_SUPERVISOR_FLAG, "--socket", socket, ...hostArgs],
		};
	}
	return {
		command: process.execPath,
		args: [...process.execArgv, resolveHostLifecycleEntryPath(), "--socket", socket, ...hostArgs],
	};
}

function resolveHostLifecycleEntryPath(): string {
	const modulePath = fileURLToPath(import.meta.url);
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	return resolve(dirname(modulePath), `host-lifecycle${extension}`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
