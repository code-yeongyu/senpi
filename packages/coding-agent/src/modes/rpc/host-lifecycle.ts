#!/usr/bin/env node
/**
 * Lifecycle supervisor for the shared RPC socket host started by ensureHost().
 *
 * Process tree:
 *
 *     ensureHost() ──detached──▶ host-lifecycle.ts (this supervisor, owns the pidfile)
 *                                    │  byte-proxies the public socket
 *                                    ▼
 *                          cli-main --mode rpc --listen unix://<public>.internal
 *
 * The supervisor exists to enforce the host lifecycle policy without touching the
 * RPC host itself:
 *
 * - cold start: `transient` (default) means the host lives for the current login
 *   session and idle-exits; `persistent` never idle-exits.
 * - idle exit: after a continuous window with zero attached client connections
 *   and zero active agent turns, the supervisor tears the host down cleanly
 *   (child SIGTERM first so the host flushes pending output and removes its own
 *   socket, then pidfile/settings removal mirroring ensureHost's cleanupState).
 *
 * Observability without host changes: proxying the public socket yields the
 * exact connection count, and the supervisor keeps one always-on observer
 * connection to the internal socket. The multi-session host broadcasts every
 * session lifecycle/agent event to every connection, so the observer sees
 * `agent_start`/`agent_settled` for all sessions even when no client is
 * attached. If the observer connection is ever unhealthy, activity is reported
 * as unknown (non-idle), so a broken observer can only keep the host alive,
 * never kill it mid-turn.
 *
 * Lifetime binding: the host is spawned with an extra inherited pipe on fd 3
 * whose write end this supervisor holds and never writes to. The kernel closes
 * that end whenever the supervisor dies - including SIGKILL, an OOM kill, or a
 * crash, where no JS handler runs at all - so the host reads EOF and shuts down
 * cleanly, removing the private internal directory. `stopChild()` remains the
 * fast path for orderly shutdowns; the pipe is what makes an orphaned host
 * impossible. `SENPI_RPC_HOST_WATCH_PPID` is passed alongside as a belt-and-
 * braces fallback for platforms where the extra fd is not inherited.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, writeSync } from "node:fs";
import { access, chmod, mkdir, readFile, rm, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../../config.ts";
import { createHostDaemonPaths } from "./host-ensure.ts";
import {
	HOST_CLEANUP_PATHS_ENV,
	HOST_SCRATCH_DIR_ENV,
	HOST_WATCH_FD_ENV,
	HOST_WATCH_PPID_ENV,
} from "./host-watchdog.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";

export type HostColdStart = "transient" | "persistent";

/** Environment override for the cold-start policy: `transient` or `persistent`. */
export const HOST_COLD_START_ENV = "SENPI_RPC_HOST_COLD_START";
/** Environment override for the idle-exit window in milliseconds. */
export const HOST_IDLE_EXIT_MS_ENV = "SENPI_RPC_HOST_IDLE_EXIT_MS";
/** Default idle-exit window: 15 minutes of continuous no-connection, no-turn idle. */
export const DEFAULT_HOST_IDLE_EXIT_MS = 15 * 60_000;

/** The policy fields ensureHost() records in rpc-host-daemon/settings.json. */
export interface HostLifecyclePolicyInput {
	readonly coldStart?: HostColdStart;
	readonly idleExitMs?: number;
}

export interface HostLifecyclePolicy {
	readonly coldStart: HostColdStart;
	readonly idleExitMs: number;
}

const CHILD_STOP_TIMEOUT_MS = 5_000;

/**
 * Child stdio slot carrying the supervisor-lifetime pipe. The supervisor holds
 * the write end open and never writes; the kernel closes it when the supervisor
 * dies for ANY reason (SIGKILL, OOM kill, crash), so the host sees EOF on this
 * fd and shuts itself down. Catchable-signal cleanup alone cannot do this.
 */
const CHILD_WATCH_FD = 3;

/**
 * The internal hop must stay short enough for sun_path (104 bytes on macOS)
 * regardless of where the public socket lives, and private against other local
 * users, so it gets its own 0700 directory under the OS temp directory.
 */
async function createInternalSocketPath(): Promise<{ socket: string; dir: string }> {
	const dir = join(tmpdir(), `senpi-rpc-host-internal-${randomUUID().slice(0, 8)}`);
	await mkdir(dir, { recursive: false, mode: 0o700 });
	return { socket: join(dir, "host.sock"), dir };
}

export function parseColdStart(value: string | undefined): HostColdStart | undefined {
	return value === "transient" || value === "persistent" ? value : undefined;
}

export function parseIdleExitMs(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolves the effective host policy. Precedence: environment overrides beat
 * settings.json, which beats the documented defaults (transient, 15 minutes).
 * Invalid values at either source fall through to the next source.
 */
export function resolveHostPolicy(
	settings: unknown,
	env: Readonly<Record<string, string | undefined>>,
): HostLifecyclePolicy {
	const record = isRecord(settings) ? settings : {};
	const coldStart =
		parseColdStart(env[HOST_COLD_START_ENV]) ?? parseColdStart(asOptionalString(record.coldStart)) ?? "transient";
	const idleExitMs =
		parseIdleExitMs(env[HOST_IDLE_EXIT_MS_ENV]) ??
		parseIdleExitMs(asOptionalString(record.idleExitMs)) ??
		DEFAULT_HOST_IDLE_EXIT_MS;
	return { coldStart, idleExitMs };
}

export interface HostActivity {
	readonly connections: number;
	readonly activeTurns: number;
}

export type IdleExitDecision = "active" | "idle" | "exit";

/**
 * Pure idle-window decision core. `update()` must be called with the CURRENT
 * activity state; the window only counts continuously idle time and any
 * activity resets it, so a busy host can never cross the threshold.
 */
export class IdleExitDecider {
	private idleSince: number | undefined;
	private readonly now: () => number;
	readonly idleExitMs: number;

	constructor(idleExitMs: number, now: () => number = Date.now) {
		this.idleExitMs = idleExitMs;
		this.now = now;
	}

	update(activity: HostActivity): IdleExitDecision {
		// Any attachment or active turn both holds the host open and resets the
		// window, so only CONTINUOUS idle can ever cross the threshold.
		if (activity.connections > 0 || activity.activeTurns > 0) {
			this.idleSince = undefined;
			return "active";
		}
		if (this.idleExitMs === Number.POSITIVE_INFINITY) return "idle";
		if (this.idleSince === undefined) {
			this.idleSince = this.now();
			return "idle";
		}
		return this.now() - this.idleSince >= this.idleExitMs ? "exit" : "idle";
	}
}

export interface SupervisorLaunch {
	readonly socket: string;
	readonly hostArgs: readonly string[];
	/** Optional runtime command used by rebranded/bundled callers. */
	readonly childCommand?: string;
	readonly childArgs?: readonly string[];
	/** Explicit ownership directory for callers whose environment is not yet branded. */
	readonly agentDir?: string;
}

/** `--socket <path>` selects the public socket; every other argument is forwarded to the host CLI. */
export function parseSupervisorArgs(argv: readonly string[]): SupervisorLaunch | undefined {
	const hostArgs: string[] = [];
	let socket: string | undefined;
	let childCommand: string | undefined;
	let childArgs: readonly string[] | undefined;
	let agentDir: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--socket" && index + 1 < argv.length) {
			socket = argv[++index];
			continue;
		}
		if (arg === "--child-command" && index + 1 < argv.length) {
			childCommand = argv[++index];
			continue;
		}
		if (arg === "--child-args" && index + 1 < argv.length) {
			try {
				const parsed: unknown = JSON.parse(argv[++index]);
				if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) childArgs = parsed;
			} catch {
				return undefined;
			}
			continue;
		}
		if (arg === "--agent-dir" && index + 1 < argv.length) {
			agentDir = argv[++index];
			continue;
		}
		hostArgs.push(arg);
	}
	return socket === undefined ? undefined : { socket, hostArgs, childCommand, childArgs, agentDir };
}

/** Resolves the committed CLI entry this supervisor wraps (source tree or built dist). */
export function resolveCliMainPath(): string {
	const modulePath = fileURLToPath(import.meta.url);
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	return resolve(dirname(modulePath), "..", "..", `cli-main${extension}`);
}

export async function runHostSupervisor(launch: SupervisorLaunch): Promise<void> {
	const paths = createHostDaemonPaths(launch.agentDir ?? getAgentDir());
	const policy = resolveHostPolicy(await readSettingsFile(paths.settingsFile), process.env);
	const publicSocket = launch.socket;
	const internal = await createInternalSocketPath();
	const internalSocket = internal.socket;
	const clientSockets = new Set<Socket>();
	const busySessions = new Map<string, number>();
	let observerHealthy = false;
	let observerReconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let shuttingDown = false;
	let shutdownPromise: Promise<never> | undefined;

	const child = spawn(
		launch.childCommand ?? process.execPath,
		launch.childCommand
			? [...(launch.childArgs ?? []), "--listen", `unix://${internalSocket}`]
			: [
					...process.execArgv,
					resolveCliMainPath(),
					"--mode",
					"rpc",
					"--multi-session",
					"--listen",
					`unix://${internalSocket}`,
					...launch.hostArgs,
				],
		{
			env: {
				...process.env,
				...(launch.agentDir ? { SENPI_CODING_AGENT_DIR: launch.agentDir } : {}),
				[HOST_WATCH_FD_ENV]: String(CHILD_WATCH_FD),
				[HOST_WATCH_PPID_ENV]: String(process.pid),
				[HOST_SCRATCH_DIR_ENV]: internal.dir,
				[HOST_CLEANUP_PATHS_ENV]: [publicSocket, paths.pidFile, paths.settingsFile].join("\n"),
			},
			// Slot 3 is the lifetime pipe: "pipe" gives the child a read end it can
			// wait on and keeps the write end owned by this process alone.
			stdio: ["ignore", "ignore", "inherit", "pipe"],
		},
	);
	// Nothing is ever written; the pipe exists purely so its EOF is a reliable
	// death notification. Errors on it must not crash the supervisor.
	child.stdio[CHILD_WATCH_FD]?.on("error", () => {});
	child.once("exit", (code, signal) => {
		if (!shuttingDown) void shutdown(`rpc host process exited unexpectedly (${code ?? signal})`, 1);
	});

	const server = createServer((client) => {
		if (shuttingDown) {
			client.destroy();
			return;
		}
		const internal = createConnection(internalSocket);
		clientSockets.add(client);
		const detach = (): void => {
			clientSockets.delete(client);
			internal.destroy();
			client.destroy();
		};
		client.pipe(internal);
		internal.pipe(client);
		client.once("close", detach);
		client.once("error", detach);
		internal.once("close", detach);
		internal.once("error", detach);
	});
	server.once("error", (cause) => {
		if (!shuttingDown) void shutdown(`public socket listener failed: ${errorMessage(cause)}`, 1);
	});

	const decider = new IdleExitDecider(
		policy.coldStart === "persistent" ? Number.POSITIVE_INFINITY : policy.idleExitMs,
	);
	const tickIntervalMs = Math.max(20, Math.min(1_000, policy.idleExitMs / 4));
	const ticker = setInterval(() => {
		if (decider.update(currentActivity()) === "exit") void shutdown("idle", 0);
	}, tickIntervalMs);

	function currentActivity(): HostActivity {
		return {
			connections: clientSockets.size,
			activeTurns: observerHealthy ? countBusySessions() : 1,
		};
	}

	function countBusySessions(): number {
		let busy = 0;
		for (const count of busySessions.values()) if (count > 0) busy++;
		return busy;
	}

	function observeHostEvent(line: string): void {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof event !== "object" || event === null) return;
		const { type, sessionId } = event as { type?: unknown; sessionId?: unknown };
		if (typeof sessionId !== "string") return;
		if (type === "agent_start") busySessions.set(sessionId, (busySessions.get(sessionId) ?? 0) + 1);
		else if (type === "agent_settled")
			busySessions.set(sessionId, Math.max(0, (busySessions.get(sessionId) ?? 1) - 1));
	}

	async function shutdown(reason: string, exitCode: number): Promise<never> {
		// Single-flight: concurrent triggers (listener error, child exit, signals)
		// must not process.exit mid-cleanup. Late callers park on this promise while
		// the first shutdown finishes tearing down and exits.
		shutdownPromise ??= performShutdown(reason, exitCode);
		return shutdownPromise;
	}

	async function performShutdown(reason: string, exitCode: number): Promise<never> {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		clearInterval(ticker);
		writeStderrLine(`senpi rpc host supervisor: ${reason} shutdown`);
		for (const client of clientSockets) client.destroy();
		await closeServer(server);
		// Unlink the private directory BEFORE the child stop, which can take seconds:
		// an external SIGKILL landing during that wait (ensureHost escalates while
		// replacing a host) would otherwise leave the directory behind. The child
		// keeps serving through its already-open socket fd until it exits, and its
		// own watchdog cleanup makes the removal idempotent.
		await rm(internal.dir, { recursive: true, force: true });
		await stopChild(child);
		observer?.destroy();
		if (publicSocketOwned) await rm(publicSocket, { force: true });
		// Mirror ensureHost's cleanupState: the pidfile and settings describe a
		// live host only; the stderr log stays for diagnostics.
		await rm(paths.pidFile, { force: true });
		await rm(paths.settingsFile, { force: true });
		process.exit(exitCode);
	}

	let observer: Socket | undefined;
	let publicSocketOwned = false;
	// Registered before the startup handshake, not after it: the private internal
	// directory already exists at this point, so a SIGTERM arriving during host
	// startup must run the same cleanup instead of Node's default kill, which
	// would leave that directory behind.
	registerSupervisorSignals(shutdown);
	try {
		await waitForListener(internalSocket, 30_000);
		await connectObserver();
		await prepareSocketPath(publicSocket);
		await listen(server, publicSocket);
		publicSocketOwned = true;
	} catch (cause) {
		await shutdown(`startup failed: ${errorMessage(cause)}`, 1);
	}
	async function connectObserver(): Promise<void> {
		const next = createConnection(internalSocket);
		await waitForConnect(next, 5_000);
		observer = next;
		observerHealthy = true;
		attachJsonlLineReader(next, observeHostEvent, { maxLineLength: MAX_RPC_LINE_CHARACTERS });
		const lost = (): void => {
			if (observer !== next || shuttingDown) return;
			observerHealthy = false;
			observer = undefined;
			if (observerReconnectTimer === undefined) {
				observerReconnectTimer = setTimeout(() => {
					observerReconnectTimer = undefined;
					void connectObserver().catch(() => lost());
				}, 250);
				observerReconnectTimer.unref?.();
			}
		};
		next.once("close", lost);
		next.once("error", lost);
	}

	writeStderrLine(
		`senpi rpc host ready on unix://${publicSocket} (coldStart=${policy.coldStart}, idleExitMs=${
			policy.coldStart === "persistent" ? "never" : String(policy.idleExitMs)
		})`,
	);
	await new Promise<never>(() => {});
}

/** External stop (ensureHost replacement, tests, QA) must clean up like idle exit. */
function registerSupervisorSignals(shutdown: (reason: string, exitCode: number) => Promise<never>): void {
	for (const signal of process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const)) {
		process.on(signal, () => {
			void shutdown(`signal:${signal}`, signal === "SIGHUP" ? 129 : 143);
		});
	}
}

async function readSettingsFile(settingsFile: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(settingsFile, "utf8"));
	} catch {
		return undefined;
	}
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill("SIGTERM");
	} catch {
		return;
	}
	if (await waitForChildExit(child, CHILD_STOP_TIMEOUT_MS)) return;
	try {
		child.kill("SIGKILL");
	} catch {
		return;
	}
	await waitForChildExit(child, 2_000);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}

async function waitForListener(socketPath: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (await canConnect(socketPath)) return;
		await delay(50);
	}
	throw new Error(`${socketPath}: host did not start listening within ${timeoutMs}ms`);
}

function canConnect(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const settle = (value: boolean): void => {
			socket.destroy();
			resolve(value);
		};
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
	});
}

function waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`observer connection to internal host timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const onConnect = (): void => {
			cleanup();
			resolve();
		};
		const onError = (cause: Error): void => {
			cleanup();
			reject(cause);
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			socket.off("connect", onConnect);
			socket.off("error", onError);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}

async function prepareSocketPath(socketPath: string): Promise<void> {
	await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
	try {
		await access(socketPath);
	} catch (cause) {
		if (isNodeErrorCode(cause, "ENOENT")) return;
		throw cause;
	}
	if (await canConnect(socketPath)) throw new Error(`${socketPath}: address already in use by a live server.`);
	await unlink(socketPath);
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, async () => {
			server.off("error", reject);
			if (!socketPath.startsWith("\0")) await chmod(socketPath, 0o600);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

function writeStderrLine(text: string): void {
	// A detached daemon exiting right after an async stderr.write to a file can
	// lose the output entirely; write synchronously so diagnostics always land.
	try {
		writeSync(2, `${text}\n`);
	} catch {
		/* fd 2 unavailable: nothing more we can do. */
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function isEntryScript(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fileURLToPath(import.meta.url) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (isEntryScript()) {
	const launch = parseSupervisorArgs(process.argv.slice(2));
	if (!launch) {
		writeStderrLine("usage: host-lifecycle.ts --socket <path> [host cli args...]");
		process.exit(2);
	}
	void runHostSupervisor(launch);
}
