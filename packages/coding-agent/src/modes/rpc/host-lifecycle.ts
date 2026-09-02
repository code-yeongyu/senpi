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
import { access, chmod, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, isBunBinary } from "../../config.ts";
import { readProcessStartTime } from "../app-server/daemon/process.ts";
import { createHostDaemonPaths } from "./host-ensure.ts";
import {
	HOST_CLEANUP_PATHS_ENV,
	HOST_SCRATCH_DIR_ENV,
	HOST_WATCH_FD_ENV,
	HOST_WATCH_PPID_ENV,
} from "./host-watchdog.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import {
	authenticateSocket,
	createSocketSecret,
	readSocketSecret,
	resolveSocketTransportAddress,
	SOCKET_SECRET_FILE_ENV,
	sendSocketHandshake,
	socketSecretPath,
} from "./socket-transport.ts";

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
/** Win32 named-pipe shutdown can leave supervisor handles live after close starts. */
const WINDOWS_SUPERVISOR_SHUTDOWN_HARD_EXIT_MS = 2_000;

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
async function createInternalSocketPath(
	baseDir = tmpdir(),
): Promise<{ socket: string; dir?: string; secretPath?: string }> {
	if (process.platform === "win32") {
		const dir = join(baseDir, `internal-${randomUUID()}`);
		await mkdir(dir, { recursive: false, mode: 0o700 });
		return {
			socket: `\\\\.\\pipe\\senpi-rpc-internal-${randomUUID()}`,
			dir,
			secretPath: join(dir, "secret"),
		};
	}
	const dir = join(tmpdir(), `senpi-rpc-host-internal-${randomUUID().slice(0, 8)}`);
	await mkdir(dir, { recursive: false, mode: 0o700 });
	await writeFile(
		join(dir, ".owner"),
		JSON.stringify({
			pid: process.pid,
			processStartTime: await readProcessStartTime(process.pid),
			createdAt: Date.now(),
		}),
		{ mode: 0o600 },
	);
	return { socket: join(dir, "host.sock"), dir, secretPath: join(dir, ".secret") };
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

/**
 * How the supervisor reads its child's exit. The RPC host exits 0 only through
 * its own clean shutdown path - including its idle/empty-host policy - so that
 * is an intentional stop, not a crash: the supervisor mirrors its own idle exit
 * instead of reporting failure. Any non-zero code or signal stays a crash.
 */
export function classifyChildExit(
	code: number | null,
	signal: NodeJS.Signals | null,
): { reason: string; exitCode: number } {
	if (code === 0 && signal === null) return { reason: "rpc host exited on its own idle policy", exitCode: 0 };
	return { reason: `rpc host process exited unexpectedly (${code ?? signal})`, exitCode: 1 };
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

/** Hidden internal launch route: wire-invisible, never advertised by the public CLI surface. */
export const INTERNAL_SUPERVISOR_FLAG = "--internal-rpc-host-supervisor";

/**
 * Engine-global flags a rebranded wrapper may legitimately prepend when it
 * re-dispatches this binary. `packages/omo-native` injects `--extension <dir>`
 * for every non-early command, which pushed the sentinel off argv[0].
 */
const INJECTABLE_PREFIX_FLAGS = new Set(["--extension"]);

/**
 * Returns the internal supervisor payload when argv selects that route.
 *
 * The route dispatches when the sentinel is argv[0] OR is preceded only by
 * known injectable prefix flags and their values - the one perturbation
 * wrappers legitimately perform. Everything else disqualifies it: a positional
 * operand, `--`, or an unknown flag before the sentinel all return undefined,
 * so a user-supplied value that happens to equal the sentinel can never reach
 * the supervisor.
 *
 * The skipped prefix is deliberately NOT forwarded to the host: a wrapper
 * re-injects its own prefix on every re-entry, so the host child receives it
 * from the wrapper rather than twice from here.
 */
export function findInternalSupervisorArgs(argv: readonly string[]): readonly string[] | undefined {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === INTERNAL_SUPERVISOR_FLAG) return argv.slice(index + 1);
		// A prefix flag only counts when its value is actually present.
		if (!INJECTABLE_PREFIX_FLAGS.has(arg) || index + 1 >= argv.length) return undefined;
		index++;
	}
	return undefined;
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

/**
 * Resolves the host child spawn. Explicit child commands (desktop launchers)
 * are forwarded untouched. The default re-enters the committed CLI entry
 * through the runtime, except in compiled standalone binaries, which always
 * boot their embedded entrypoint and would parse a script path as CLI
 * arguments - there the executable itself is the CLI, so the mode flags are
 * passed directly. Exported for tests.
 */
export function resolveHostChildLaunch(
	launch: SupervisorLaunch,
	internalSocket: string,
	compiled: boolean = isBunBinary,
): { command: string; args: string[] } {
	if (launch.childCommand) {
		return {
			command: launch.childCommand,
			args: [...(launch.childArgs ?? []), "--listen", `unix://${internalSocket}`],
		};
	}
	return {
		command: process.execPath,
		args: [
			...(compiled ? [] : [...process.execArgv, resolveCliMainPath()]),
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			`unix://${internalSocket}`,
			...launch.hostArgs,
		],
	};
}

/** Mirrors cross-spawn: survives cmd.exe parsing and `CommandLineToArgvW`. */
function quoteWindowsShellArg(value: string): string {
	const escaped = value
		.replace(/(\\*)"/g, '$1$1\\"')
		.replace(/(\\*)$/, "$1$1")
		.replace(/([()%!^"<>&|;,])/g, "^$1");
	return `"${escaped}"`;
}

/**
 * Windows refuses to spawn a `.cmd`/`.bat` without a shell, and Node's
 * `shell: true` concatenates argv without escaping it. Escape each original
 * value before adding the surrounding quotes so `.cmd`/`.bat` launchers survive
 * cmd.exe parsing without double-escaping.
 * Exported for tests.
 */
export function spawnableChildLaunch(
	launch: { command: string; args: string[] },
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
	const extension = extname(launch.command).toLowerCase();
	if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
		return { ...launch, shell: false };
	}
	return {
		command: quoteWindowsShellArg(launch.command),
		args: launch.args.map(quoteWindowsShellArg),
		shell: true,
	};
}

export async function runHostSupervisor(launch: SupervisorLaunch): Promise<void> {
	const paths = createHostDaemonPaths(launch.agentDir ?? getAgentDir());
	const policy = resolveHostPolicy(await readSettingsFile(paths.settingsFile), process.env);
	const publicSocket = launch.socket;
	const internal = await createInternalSocketPath(paths.dir);
	const internalSocket = internal.socket;
	const internalSecretPath = internal.secretPath ?? socketSecretPath(internalSocket);
	const internalSecret = process.platform === "win32" ? await createSocketSecret(internalSecretPath) : undefined;
	const publicSecret =
		process.platform === "win32" ? await readSocketSecret(socketSecretPath(publicSocket)) : undefined;
	const clientSockets = new Set<Socket>();
	const busySessions = new Map<string, number>();
	let observerHealthy = false;
	let observerReconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let childExitWatchTimer: ReturnType<typeof setInterval> | undefined;
	let shuttingDown = false;
	let shutdownPromise: Promise<never> | undefined;

	const childLaunch = spawnableChildLaunch(resolveHostChildLaunch(launch, internalSocket));
	const child = spawn(childLaunch.command, childLaunch.args, {
		env: {
			...process.env,
			...(launch.agentDir ? { SENPI_CODING_AGENT_DIR: launch.agentDir } : {}),
			[HOST_WATCH_FD_ENV]: String(CHILD_WATCH_FD),
			[HOST_WATCH_PPID_ENV]: String(process.pid),
			...(internal.dir ? { [HOST_SCRATCH_DIR_ENV]: internal.dir } : {}),
			...(internalSecret ? { [SOCKET_SECRET_FILE_ENV]: internalSecretPath } : {}),
			[HOST_CLEANUP_PATHS_ENV]: [
				paths.pidFile,
				paths.settingsFile,
				...(process.platform === "win32" ? [] : [publicSocket]),
			].join("\n"),
		},
		// Slot 3 is the lifetime pipe: "pipe" gives the child a read end it can
		// wait on and keeps the write end owned by this process alone.
		shell: childLaunch.shell,
		stdio: ["ignore", "ignore", "inherit", "pipe"],
		// The supervisor is spawned detached, so on win32 it owns no console. A
		// console-subsystem child started from it would allocate a fresh one,
		// which Windows Terminal renders as an empty window that takes focus.
		// CREATE_NO_WINDOW gives the child a console with no window instead.
		windowsHide: true,
	});
	// Nothing is ever written; the pipe exists purely so its EOF is a reliable
	// death notification. Errors on it must not crash the supervisor.
	child.stdio[CHILD_WATCH_FD]?.on("error", () => {});
	child.once("exit", (code, signal) => {
		if (shuttingDown) return;
		const { reason, exitCode } = classifyChildExit(code, signal);
		void shutdown(reason, exitCode);
	});

	const server = createServer((client) => {
		const accept = (): void => {
			if (shuttingDown) {
				client.destroy();
				return;
			}
			const internal = createConnection(
				resolveSocketTransportAddress(internalSocket, process.platform, internalSecret),
			);
			if (internalSecret) sendSocketHandshake(internal, internalSecret);
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
		};
		if (publicSecret) authenticateSocket(client, publicSecret, accept);
		else accept();
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
		if (childExitWatchTimer) clearInterval(childExitWatchTimer);
		const hardExit =
			process.platform === "win32"
				? setTimeout(() => process.exit(exitCode), WINDOWS_SUPERVISOR_SHUTDOWN_HARD_EXIT_MS)
				: undefined;
		try {
			writeStderrLine(`senpi rpc host supervisor: ${reason} shutdown`);
			for (const client of clientSockets) client.destroy();
			await closeServer(server);
			// Unlink the private directory BEFORE the child stop, which can take seconds:
			// an external SIGKILL landing during that wait (ensureHost escalates while
			// replacing a host) would otherwise leave the directory behind. The child
			// keeps serving through its already-open socket fd until it exits, and its
			// own watchdog cleanup makes the removal idempotent.
			if (internal.dir) await rm(internal.dir, { recursive: true, force: true });
			await stopChild(child);
			observer?.destroy();
			if (publicSocketOwned && process.platform !== "win32") await rm(publicSocket, { force: true });
			// Mirror ensureHost's cleanupState: the pidfile and settings describe a
			// live host only; the stderr log stays for diagnostics.
			await rm(paths.pidFile, { force: true });
			await rm(paths.settingsFile, { force: true });
		} finally {
			if (hardExit) clearTimeout(hardExit);
			// Explicitly terminate after every supervisor shutdown trigger. Windows
			// named-pipe handles can outlive their JavaScript wrappers, so cleanup
			// failure must never leave the supervisor resident or the host orphaned.
			process.exit(exitCode);
		}
	}

	let observer: Socket | undefined;
	let publicSocketOwned = false;
	// Registered before the startup handshake, not after it: the private internal
	// directory already exists at this point, so a SIGTERM arriving during host
	// startup must run the same cleanup instead of Node's default kill, which
	// would leave that directory behind.
	registerSupervisorSignals(shutdown);
	try {
		await waitForListener(internalSocket, 30_000, internalSecret);
		await connectObserver();
		await prepareSocketPath(publicSocket);
		await listen(server, publicSocket, publicSecret);
		publicSocketOwned = true;
	} catch (cause) {
		await shutdown(`startup failed: ${errorMessage(cause)}`, 1);
	}
	async function connectObserver(): Promise<void> {
		const secret = internalSecret;
		const next = createConnection(resolveSocketTransportAddress(internalSocket, process.platform, secret));
		if (secret) sendSocketHandshake(next, secret);
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

	if (process.platform === "win32" && child.pid !== undefined) {
		const childStartTime = await readProcessStartTime(child.pid, process.platform, 1_000);
		let missingIdentityChecks = 0;
		let checkingChildIdentity = false;
		const checkChildIdentity = (): void => {
			if (shuttingDown || checkingChildIdentity || child.exitCode !== null || child.signalCode !== null) return;
			checkingChildIdentity = true;
			void readProcessStartTime(child.pid!, process.platform, 1_000)
				.then((currentStartTime) => {
					if (currentStartTime === undefined) missingIdentityChecks++;
					else missingIdentityChecks = 0;
					const identityChanged =
						childStartTime !== undefined && currentStartTime !== undefined && currentStartTime !== childStartTime;
					if (identityChanged || missingIdentityChecks >= 2) {
						void shutdown("rpc host child exit observed by identity watchdog", 0);
					}
				})
				.catch(() => {})
				.finally(() => {
					checkingChildIdentity = false;
				});
		};
		childExitWatchTimer = setInterval(checkChildIdentity, 500);
		childExitWatchTimer.unref?.();
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

async function waitForListener(socketPath: string, timeoutMs: number, secret?: Uint8Array): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (await canConnect(socketPath, secret)) return;
		await delay(50);
	}
	throw new Error(`${socketPath}: host did not start listening within ${timeoutMs}ms`);
}

function canConnect(socketPath: string, secret?: Uint8Array): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		if (secret) sendSocketHandshake(socket, secret);
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
	if (process.platform === "win32") return;
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

function listen(server: Server, socketPath: string, secret?: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(
			{
				path: resolveSocketTransportAddress(socketPath, process.platform, secret),
				readableAll: false,
				writableAll: false,
			},
			async () => {
				server.off("error", reject);
				try {
					if (process.platform !== "win32" && !socketPath.startsWith("\0")) await chmod(socketPath, 0o600);
					resolve();
				} catch (cause) {
					reject(cause);
				}
			},
		);
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
