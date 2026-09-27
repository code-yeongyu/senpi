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
 * never kill it mid-turn - for one idle window. Past that, unknown has held
 * the host open for as long as idleness itself would have, and it stops
 * counting as busy; the link keeps reconnecting the whole time (#1979).
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
import { existsSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, isBunBinary, isBundledNode } from "../../config.ts";
import { processIsLive, readProcessStartTime } from "../app-server/daemon/process.ts";
import { classifyChildExit, noteChildExit } from "./host-child-exit.ts";

// The exit verdict moved to ./host-child-exit.ts with the crash recording it now feeds; it stays
// exported from here so every existing importer keeps resolving it at its original home.
export { classifyChildExit } from "./host-child-exit.ts";

import { createHostDaemonPaths, generationPaths, HOST_DAEMON_DIR_ENV } from "./host-daemon-paths.ts";
import { releaseGeneration } from "./host-daemon-registration.ts";
import { watchForSupersession } from "./host-supersession.ts";
import {
	HOST_CLEANUP_PATHS_ENV,
	HOST_PUBLIC_SOCKET_ENV,
	HOST_SCRATCH_DIR_ENV,
	HOST_WATCH_FD_ENV,
	HOST_WATCH_PPID_ENV,
} from "./host-watchdog.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { activeTurnsForIdleDecision, createObserverLink } from "./observer-link.ts";
import { HOST_INSTANCE_ID_ENV } from "./protocol-identity.ts";
import {
	MAX_SOCKET_PATH_BYTES,
	PUBLIC_SOCKET_IDENTITY_FILE,
	type SocketFileIdentity,
	shieldSocketDuringClose,
	statSocketIdentity,
	unlinkOwnedSocket,
	writeSocketIdentityFile,
} from "./socket-ownership.ts";
import {
	authenticateSocket,
	createSocketSecret,
	ensureSocketSecret,
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
/** Soft handoff deadline: rescan and report, never interrupt turns or in-flight requests. */
export const HANDOFF_GRACE_MS_ENV = "SENPI_RPC_HANDOFF_GRACE_MS";
export const DEFAULT_HANDOFF_GRACE_MS = 10 * 60_000;

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
 *
 * On win32 the directory lives under the caller-supplied rpc-host-daemon
 * directory, which ensureHost() creates but a direct --internal-rpc-host-supervisor
 * launch does not, so the parent is created recursively.
 */
export async function createInternalSocketPath(
	baseDir = tmpdir(),
	platform: NodeJS.Platform = process.platform,
): Promise<{ socket: string; dir?: string; secretPath?: string }> {
	if (platform === "win32") {
		const dir = join(baseDir, `internal-${randomUUID()}`);
		await mkdir(dir, { recursive: true, mode: 0o700 });
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
	/**
	 * Where this supervisor BINDS, when it is a successor generation: `<socket>.next-<gen>`.
	 * It renames that entry over `socket` once its host answers - and never binds the live
	 * public path, which belongs to the generation currently serving it.
	 */
	readonly bindSocket?: string;
	/**
	 * The public socket entry this generation is allowed to replace (`<dev>:<ino>`). The rename
	 * happens only while the path still refers to it: a socket that changed underneath belongs to
	 * somebody else now, and replacing it would unlink an endpoint this process cannot prove it owns.
	 */
	readonly replaceIdentity?: SocketFileIdentity;
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
	let bindSocket: string | undefined;
	let replaceIdentity: SocketFileIdentity | undefined;
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
		if (arg === "--bind" && index + 1 < argv.length) {
			bindSocket = argv[++index];
			continue;
		}
		if (arg === "--replace" && index + 1 < argv.length) {
			replaceIdentity = parseSocketIdentity(argv[++index]);
			continue;
		}
		hostArgs.push(arg);
	}
	return socket === undefined
		? undefined
		: { socket, hostArgs, childCommand, childArgs, agentDir, bindSocket, replaceIdentity };
}

/** `<dev>:<ino>` as the ensure captured it; anything else is no identity at all, never a guess. */
function parseSocketIdentity(value: string): SocketFileIdentity | undefined {
	const match = /^(\d+):(\d+)$/.exec(value);
	return match ? { dev: Number(match[1]), ino: Number(match[2]) } : undefined;
}

/** Resolves the committed CLI entry this supervisor wraps (source tree or built dist). */
export function resolveCliMainPath(): string {
	const modulePath = fileURLToPath(import.meta.url);
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	const unbundled = resolve(dirname(modulePath), "..", "..", `cli-main${extension}`);
	if (existsSync(unbundled)) return unbundled;
	// Bundled, ".." twice reaches the PACKAGE ROOT rather than dist/, naming a cli-main that
	// was never emitted. Take the entry from the package's own declared bin instead of
	// counting directories: it is the one statement of where the CLI lives that holds in
	// every layout. Falls back to the old path when nothing is declared, so a caller that
	// was working keeps working.
	return resolveDeclaredCliEntry(modulePath) ?? unbundled;
}

/** The CLI entry declared by the nearest enclosing package.json, when it exists on disk. */
function resolveDeclaredCliEntry(modulePath: string): string | undefined {
	let dir = dirname(modulePath);
	for (let depth = 0; depth < 8; depth += 1) {
		const manifestPath = resolve(dir, "package.json");
		if (existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
					bin?: Record<string, string> | string;
				};
				const declared = manifest.bin;
				const candidates = typeof declared === "string" ? [declared] : Object.values(declared ?? {});
				for (const candidate of candidates) {
					const entry = resolve(dir, candidate);
					if (existsSync(entry)) return entry;
				}
			} catch {}
			return undefined;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
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
	const paths = createHostDaemonPaths({ socket: launch.socket, agentDir: launch.agentDir ?? getAgentDir() });
	// Which generation this supervisor is: the ensure that spawned it says so, and a DIRECT launch
	// (the hidden supervisor route, with no ensure behind it) names itself so its child agrees.
	const told = process.env[HOST_INSTANCE_ID_ENV];
	const instanceId = told !== undefined && told.trim() !== "" ? told : randomUUID();
	const generation = generationPaths(paths, instanceId);
	const policy = resolveHostPolicy(await readSettingsFile(paths.settingsFile), process.env);
	const publicSocket = launch.socket;
	// A successor generation binds its own name and adopts the public one by rename; an ordinary
	// start binds the public name directly. Everything downstream - the child's environment, the
	// ownership token, the teardown - is expressed in terms of the PUBLIC path either way.
	const bindSocket = launch.bindSocket ?? publicSocket;
	const successor = launch.bindSocket !== undefined;
	// Direct-launch contract: the supervisor owns the public secret. ensureHost()
	// writes it before spawning, but the hidden --internal-rpc-host-supervisor route
	// has no such caller, so a fresh profile would otherwise die reading it (#1370).
	// It is provisioned BEFORE the internal hop and the child so a provisioning
	// failure leaves no scratch directory and no host process behind.
	const publicSecret = process.platform === "win32" ? await ensurePublicSocketSecret(publicSocket) : undefined;
	const internal = await createInternalSocketPath(paths.dir);
	const internalSocket = internal.socket;
	const internalSecretPath = internal.secretPath ?? socketSecretPath(internalSocket);
	const internalSecret = process.platform === "win32" ? await createSocketSecret(internalSecretPath) : undefined;
	const clientSockets = new Set<Socket>();
	const busySessions = new Map<string, number>();
	// Declared before anything that can reach `currentActivity()`. A client accepted during startup
	// asks for the activity snapshot, and a `const` read before its initializer runs is a
	// ReferenceError that fails the connection - which is how a successor's first `open_session`
	// came back `success: false` during a handoff.
	let observerSocket: Socket | undefined;
	const observerLink = createObserverLink({
		open: async () => {
			const secret = internalSecret;
			const next = createConnection(resolveSocketTransportAddress(internalSocket, process.platform, secret));
			if (secret) sendSocketHandshake(next, secret);
			await waitForConnect(next, 5_000);
			observerSocket = next;
			attachJsonlLineReader(next, observeHostEvent, { maxLineLength: MAX_RPC_LINE_CHARACTERS });
			return {
				onLost: (handler) => {
					next.once("close", handler);
					next.once("error", handler);
				},
			};
		},
		settled: () => shuttingDown,
		retryDelayMs: 250,
		now: Date.now,
		setTimer: (run, ms) => {
			const timer = setTimeout(run, ms);
			timer.unref?.();
			return { cancel: () => clearTimeout(timer) };
		},
	});
	let childExitWatchTimer: ReturnType<typeof setInterval> | undefined;
	let stopSupersessionWatch: (() => void) | undefined;
	let shuttingDown = false;
	let draining = false;
	let handoffGraceTimer: ReturnType<typeof setTimeout> | undefined;
	let shutdownPromise: Promise<never> | undefined;

	const childLaunch = spawnableChildLaunch(resolveHostChildLaunch(launch, internalSocket));
	const child = spawn(childLaunch.command, childLaunch.args, {
		env: {
			...process.env,
			...(launch.agentDir ? { SENPI_CODING_AGENT_DIR: launch.agentDir } : {}),
			// The child binds a PRIVATE socket, so it cannot derive this endpoint's daemon directory
			// from what it listens on: it is told, and it claims its session paths there.
			[HOST_DAEMON_DIR_ENV]: paths.dir,
			[HOST_INSTANCE_ID_ENV]: instanceId,
			[HOST_WATCH_FD_ENV]: String(CHILD_WATCH_FD),
			[HOST_WATCH_PPID_ENV]: String(process.pid),
			...(internal.dir ? { [HOST_SCRATCH_DIR_ENV]: internal.dir } : {}),
			...(internalSecret ? { [SOCKET_SECRET_FILE_ENV]: internalSecretPath } : {}),
			[HOST_CLEANUP_PATHS_ENV]: [
				// A successor writes no registration of its own until the ensure that spawned it does,
				// and the files under these paths still describe the generation being replaced.
				...(successor ? [] : [paths.pointerFile, generation.pidFile, paths.settingsFile]),
				// POSIX public sockets are removed ownership-checked by the host child
				// (token: the scratch-directory sidecar plus HOST_PUBLIC_SOCKET_ENV),
				// never by path from a crash-path cleanup: a blind removal here would
				// unlink a newer host's freshly published entry after a takeover.
				// Windows named pipes have no filesystem entry to own, so they stay
				// listed for the crash-path cleanup.
				...(process.platform === "win32" ? [publicSocket] : []),
			].join("\n"),
			...(process.platform === "win32" ? {} : { [HOST_PUBLIC_SOCKET_ENV]: publicSocket }),
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
	const childStartedAt = Date.now();
	// Nothing is ever written; the pipe exists purely so its EOF is a reliable
	// death notification. Errors on it must not crash the supervisor.
	child.stdio[CHILD_WATCH_FD]?.on("error", () => {});
	child.once("exit", (code, signal) => {
		if (shuttingDown) return;
		const { reason, exitCode } = classifyChildExit(code, signal);
		// Record BEFORE shutting down: `shutdown` ends in `process.exit`, so anything queued after
		// it is never reached. Writing is best-effort and never throws into this path.
		noteChildExit(paths.dir, code, signal, childStartedAt);
		void shutdown(reason, exitCode);
	});

	const server = createServer((client) => {
		const accept = (): void => {
			// A draining supervisor serves what it already proxies and accepts nothing new. After a
			// handoff the public path resolves to the successor anyway; this covers the connection
			// that raced the rename, and a drain-stop with no successor at all.
			if (shuttingDown || draining) {
				client.destroy();
				return;
			}
			const internal = createConnection(
				resolveSocketTransportAddress(internalSocket, process.platform, internalSecret),
			);
			if (internalSecret) sendSocketHandshake(internal, internalSecret);
			clientSockets.add(client);
			writeStderrLine(`DIAG2227 supervisor attach at=${Date.now()} clients=${clientSockets.size}`);
			// A readiness exchange can begin and end between ticks. Record the
			// attachment now, before a later tick can reuse the preceding idle window.
			decider.update(currentActivity());
			const detach = (): void => {
				clientSockets.delete(client);
				writeStderrLine(`DIAG2227 supervisor detach at=${Date.now()} clients=${clientSockets.size}`);
				decider.update(currentActivity());
				internal.destroy();
				client.destroy();
			};
			client.pipe(internal);
			internal.pipe(client);
			client.once("close", detach);
			client.once("error", detach);
			// Let the final lifecycle records drain through the public socket before closing it.
			internal.once("end", () => client.end(() => client.destroy()));
			internal.once("close", () => {
				if (!internal.readableEnded) detach();
			});
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
		if (!draining && decider.update(currentActivity()) === "exit") {
			writeStderrLine(`DIAG2227 supervisor idle-exit at=${Date.now()}`);
			void shutdown("idle", 0);
		}
	}, tickIntervalMs);

	function currentActivity(): HostActivity {
		return {
			connections: clientSockets.size,
			activeTurns: activeTurnsForIdleDecision({
				healthy: observerLink.healthy(),
				unhealthySince: observerLink.unhealthySince(),
				now: Date.now(),
				unknownGraceMs: decider.idleExitMs,
				observedBusy: countBusySessions(),
			}),
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
		else return;
		decider.update(currentActivity());
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
		if (handoffGraceTimer) clearTimeout(handoffGraceTimer);
		if (childExitWatchTimer) clearInterval(childExitWatchTimer);
		stopSupersessionWatch?.();
		const hardExit =
			process.platform === "win32"
				? setTimeout(() => process.exit(exitCode), WINDOWS_SUPERVISOR_SHUTDOWN_HARD_EXIT_MS)
				: undefined;
		try {
			writeStderrLine(`senpi rpc host supervisor: ${reason} shutdown (DIAG2227 at=${Date.now()})`);
			for (const client of clientSockets) client.destroy();
			// libuv unlinks the bound NAME when the listening handle closes - which
			// would delete a newer host's entry renamed over this path. Shield the
			// current entry for the close, then let the ownership check decide. A drained
			// supervisor already closed that handle when it stopped accepting.
			if (!draining) await shieldSocketDuringClose(publicSocket, () => closeServer(server));
			// Unlink the private directory BEFORE the child stop, which can take seconds:
			// an external SIGKILL landing during that wait (ensureHost escalates while
			// replacing a host) would otherwise leave the directory behind. The child
			// keeps serving through its already-open socket fd until it exits, and its
			// own watchdog cleanup makes the removal idempotent.
			if (internal.dir) await rm(internal.dir, { recursive: true, force: true });
			await stopChild(child);
			observerLink.stop();
			observerSocket?.destroy();
			if (publicSocketOwned && process.platform !== "win32") {
				// Ownership-checked: after a takeover, a newer host may have published
				// a fresh entry at this path; only the entry THIS supervisor bound is
				// removed. (The host child applies the same rule to its crash path.)
				await unlinkOwnedSocket(publicSocket, publicSocketIdentity, supervisorLog);
			}
			// The registration describes a LIVE host only; the stderr log stays for diagnostics.
			// After a handoff the pointer describes the SUCCESSOR, so this drops only the generation
			// directory of the process that is leaving, and the pointer only while it still names it.
			await releaseGeneration(paths, { instanceId, pid: process.pid });
		} finally {
			if (hardExit) clearTimeout(hardExit);
			// Explicitly terminate after every supervisor shutdown trigger. Windows
			// named-pipe handles can outlive their JavaScript wrappers, so cleanup
			// failure must never leave the supervisor resident or the host orphaned.
			process.exit(exitCode);
		}
	}

	let publicSocketOwned = false;
	let publicSocketIdentity: SocketFileIdentity | undefined;
	function supervisorLog(message: string): void {
		writeStderrLine(`senpi rpc host supervisor: ${message}`);
	}
	// Registered before the startup handshake, not after it: the private internal
	// directory already exists at this point, so a SIGTERM arriving during host
	// startup must run the same cleanup instead of Node's default kill, which
	// would leave that directory behind.
	/**
	 * Ask the child to announce and park attached sessions as turns/requests settle. The supervisor
	 * owns the soft grace from this instant; expiry rescans but NEVER kills busy sessions. Child
	 * exit ends the supervisor regardless of clients that keep their connections open.
	 */
	function drainForHandoff(): void {
		if (draining || shuttingDown) return;
		draining = true;
		supervisorLog("draining into the next generation");
		const graceMs = parseIdleExitMs(process.env[HANDOFF_GRACE_MS_ENV]) ?? DEFAULT_HANDOFF_GRACE_MS;
		handoffGraceTimer = setTimeout(() => {
			supervisorLog(JSON.stringify({ event: "handoff_grace_expired", graceMs }));
			requestChildDrain();
		}, graceMs);
		handoffGraceTimer.unref();
		// The listening handle is deliberately NOT closed: libuv unlinks a pipe's bound NAME when it
		// closes, and after a handoff that name is the successor's entry. Nothing can reach this
		// listener by path any more (the rename moved the name), and the accept guard above turns
		// away whatever raced it, so leaving the handle open until exit costs nothing and keeps the
		// public path continuously answerable - no window where a client finds no socket at all.
		requestChildDrain();
	}
	function requestChildDrain(): void {
		if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(child.pid, "SIGUSR1");
			} catch (cause) {
				supervisorLog(`could not ask the host to drain: ${errorMessage(cause)}`);
			}
		}
	}
	registerSupervisorSignals(shutdown, drainForHandoff);
	try {
		await waitForListener(internalSocket, 30_000, internalSecret);
		await observerLink.open();
		await prepareSocketPath(bindSocket);
		await listen(server, bindSocket, publicSecret);
		publicSocketOwned = true;
		if (successor) await adoptPublicSocket(bindSocket, publicSocket, launch.replaceIdentity);
		publicSocketIdentity = await statSocketIdentity(publicSocket);
		// Publish the ownership token inside this supervisor's private scratch
		// directory (which no replacement supervisor writes): the host child's
		// crash-path cleanup compares the public path against THIS entry only.
		if (publicSocketIdentity && internal.dir) {
			await writeSocketIdentityFile(join(internal.dir, PUBLIC_SOCKET_IDENTITY_FILE), publicSocketIdentity);
		}
		// Losing the public entry IS a drain request: nothing can reach this supervisor by path any
		// more, and the handoff that replaced it may never have signalled (#1893). A name that was
		// deleted rather than taken over is the same loss with nobody serving the path (#1961).
		stopSupersessionWatch = watchForSupersession(
			{ path: publicSocket, identity: publicSocketIdentity, settled: () => shuttingDown || draining },
			(loss) => {
				supervisorLog(
					loss === "absent"
						? "the public socket entry is gone; nothing can reach this generation; draining"
						: "another generation owns the public socket; draining this one",
				);
				drainForHandoff();
			},
		);
	} catch (cause) {
		await shutdown(`startup failed: ${errorMessage(cause)}`, 1);
	}
	if (process.platform === "win32" && child.pid !== undefined) {
		// This baseline read sits outside the startup try/catch, and readProcessStartTime
		// THROWS when the 1s CIM probe fails (execFile's timeout SIGTERMs the PowerShell
		// child). With no unhandledRejection handler the supervisor died right here on a
		// loaded runner: it never reached the "host ready" line, and the internal host it
		// owned vanished with it, surfacing downstream as `connect ENOENT` on the pipe and
		// as `reported dead`. A failed baseline read is UNKNOWN, so the watchdog simply
		// starts without one and relies on its own comparisons.
		const childStartTime = await readProcessStartTime(child.pid, process.platform, 1_000).catch(() => undefined);
		let missingIdentityChecks = 0;
		let checkingChildIdentity = false;
		const checkChildIdentity = (): void => {
			if (shuttingDown || checkingChildIdentity || child.exitCode !== null || child.signalCode !== null) return;
			checkingChildIdentity = true;
			void readProcessStartTime(child.pid!, process.platform, 1_000)
				.then((currentStartTime) => {
					// An absent identity is only believed once kill(pid, 0) agrees the child is
					// gone. This probe is a 1s PowerShell CIM spawn polled every 500ms, so a
					// loaded runner produced two consecutive timeouts and this watchdog shut
					// down a perfectly healthy host (`does not exit while a turn is active`).
					// A timed-out probe means UNKNOWN, never EXITED.
					if (currentStartTime === undefined && !processIsLive(child.pid!)) missingIdentityChecks++;
					else if (currentStartTime !== undefined) missingIdentityChecks = 0;
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

/**
 * External stop (ensureHost replacement, tests, QA) must clean up like idle exit; SIGUSR1 is the
 * gentler request - finish what you are doing and leave - that a generation handoff and
 * `stopHost({ drain: true })` both send. It exists on POSIX only, which is one reason win32 hosts
 * are attach-only: no signal there means anything but "terminate".
 */
function registerSupervisorSignals(
	shutdown: (reason: string, exitCode: number) => Promise<never>,
	drain: () => void,
): void {
	for (const signal of process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const)) {
		process.on(signal, () => {
			void shutdown(`signal:${signal}`, signal === "SIGHUP" ? 129 : 143);
		});
	}
	if (process.platform !== "win32") process.on("SIGUSR1", drain);
}

/**
 * Takes the public name over with a rename, once - and only while - that name still refers to the
 * entry this handoff was decided against. A socket that changed underneath belongs to another
 * process now: replacing it would unlink an endpoint this generation cannot prove it owns, so the
 * successor aborts instead and leaves both the intruder's socket and its own bind entry alone.
 */
async function adoptPublicSocket(
	bindSocket: string,
	publicSocket: string,
	expected: SocketFileIdentity | undefined,
): Promise<void> {
	if (expected === undefined) throw new Error(`${publicSocket}: a generation launch must name the entry it replaces`);
	const current = await statSocketIdentity(publicSocket);
	if (current === undefined || current.dev !== expected.dev || current.ino !== expected.ino) {
		throw new Error(`${publicSocket}: owned by another socket entry now; refusing to replace it`);
	}
	// rename(2) is atomic for readers of the path: every connect either reaches the old entry or
	// this one, never nothing. The inode this supervisor bound simply answers to a second name.
	await rename(bindSocket, publicSocket);
}

/**
 * Reuses an existing valid secret - including one ensureHost() just wrote - and
 * creates one (with its parent directories, mode 0600) when it is missing or
 * unusable. Reuse is required, not just an optimization: on win32 the pipe name
 * is derived from the socket path AND the secret, so rotating it here would
 * point this supervisor at a different endpoint than its caller published.
 * A failure names the bootstrap step and the path it could not provision.
 */
async function ensurePublicSocketSecret(publicSocket: string): Promise<Buffer> {
	const secretPath = socketSecretPath(publicSocket);
	try {
		return await ensureSocketSecret(secretPath);
	} catch (cause) {
		throw new Error(`senpi rpc host supervisor: cannot provision public socket secret ${secretPath}`, { cause });
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
	// A path the kernel would truncate binds a DIFFERENT endpoint than the one every client was
	// told about, and the failure surfaces much later as "the host does not answer". Refuse here.
	if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
		throw new Error(
			`${socketPath}: socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit.`,
		);
	}
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

if (!isBundledNode && isEntryScript()) {
	const launch = parseSupervisorArgs(process.argv.slice(2));
	if (!launch) {
		writeStderrLine("usage: host-lifecycle.ts --socket <path> [host cli args...]");
		process.exit(2);
	}
	void runHostSupervisor(launch);
}
