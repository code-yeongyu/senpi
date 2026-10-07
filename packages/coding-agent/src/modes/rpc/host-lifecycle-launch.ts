/**
 * WHAT the lifecycle supervisor is launched with and WHAT it launches: its hidden argv route, the
 * argv it parses, and the host child it spawns. Split out of `host-lifecycle.ts`, which keeps the
 * supervisor's orchestration; every name stays re-exported there for existing importers.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { extname } from "node:path";
import { isBunBinary } from "../../config.ts";
import { resolveCliMainPath } from "./host-cli-entry.ts";
import { HOST_DAEMON_DIR_ENV } from "./host-daemon-paths.ts";
import { rpcHostExecArgv } from "./host-exec-argv.ts";
import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import {
	HOST_CLEANUP_PATHS_ENV,
	HOST_PUBLIC_SOCKET_ENV,
	HOST_SCRATCH_DIR_ENV,
	HOST_WATCH_FD_ENV,
	HOST_WATCH_PPID_ENV,
} from "./host-watchdog.ts";
import type { SocketFileIdentity } from "./socket-ownership.ts";
import { SOCKET_SECRET_FILE_ENV } from "./socket-transport.ts";

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

export { resolveCliMainPath } from "./host-cli-entry.ts";

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
			...(compiled ? [] : [...rpcHostExecArgv(), resolveCliMainPath()]),
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

/**
 * Child stdio slot carrying the supervisor-lifetime pipe. The supervisor holds
 * the write end open and never writes; the kernel closes it when the supervisor
 * dies for ANY reason (SIGKILL, OOM kill, crash), so the host sees EOF on this
 * fd and shuts itself down. Catchable-signal cleanup alone cannot do this.
 */
export const HOST_CHILD_WATCH_FD = 3;

/** Spawns the host child with the environment that binds it to this supervisor and its generation. */
export function spawnHostChild(options: {
	readonly launch: SupervisorLaunch;
	readonly internalSocket: string;
	readonly internal: { readonly dir?: string; readonly secretPath: string };
	readonly internalSecret?: Buffer;
	readonly daemonDir: string;
	readonly instanceId: string;
	readonly cleanupPaths: readonly string[];
	readonly publicSocket: string;
}): ChildProcess {
	const { launch, internalSocket, internal, internalSecret, publicSocket } = options;
	const childLaunch = spawnableChildLaunch(resolveHostChildLaunch(launch, internalSocket));
	return spawn(childLaunch.command, childLaunch.args, {
		env: {
			...process.env,
			...(launch.agentDir ? { SENPI_CODING_AGENT_DIR: launch.agentDir } : {}),
			// The child binds a PRIVATE socket, so it cannot derive this endpoint's daemon directory
			// from what it listens on: it is told, and it claims its session paths there.
			[HOST_DAEMON_DIR_ENV]: options.daemonDir,
			[HOST_INSTANCE_ID_ENV]: options.instanceId,
			[HOST_WATCH_FD_ENV]: String(HOST_CHILD_WATCH_FD),
			[HOST_WATCH_PPID_ENV]: String(process.pid),
			...(internal.dir ? { [HOST_SCRATCH_DIR_ENV]: internal.dir } : {}),
			...(internalSecret ? { [SOCKET_SECRET_FILE_ENV]: internal.secretPath } : {}),
			[HOST_CLEANUP_PATHS_ENV]: options.cleanupPaths.join("\n"),
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
}
