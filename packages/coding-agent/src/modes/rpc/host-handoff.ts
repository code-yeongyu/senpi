/**
 * Replacing a running daemon without ending the work it is doing.
 *
 * An upgrade cannot mean "kill the host and start a newer one": one machine-wide daemon
 * holds every client's sessions, so that is a data-loss operation dressed as a version
 * bump. A GENERATION HANDOFF replaces the process while the work continues:
 *
 *   1. the successor binds `<public>.next-<gen>` - never the live public path, which it
 *      has no right to unlink - and only renames its own entry over the public path once
 *      its host answers, and only while that path still holds the exact socket this
 *      handoff was decided against (`--replace <dev>:<ino>`);
 *   2. the predecessor is then asked to DRAIN with SIGUSR1: it stops accepting, keeps
 *      every connection it is already proxying, parks each retained session as its turn
 *      settles, and exits through its ordinary idle path;
 *   3. clients that arrive in between reach whichever generation owns the path at that
 *      instant - both are alive and serving.
 *
 * Two guards make this safe rather than merely clever. SIGUSR1 has a DEFAULT DISPOSITION OF
 * TERMINATE, so a host that does not advertise `generation_handoff` is never signalled - it
 * would die, taking its sessions with it. And a host whose pidfile identity cannot be proven
 * is never signalled either (I1), because "the process at this pid" is not evidence.
 *
 * win32 has neither a renameable named pipe nor SIGUSR1, so every entry point here refuses
 * with `upgrade_unsupported`; upgrades there apply after a drain-stop or an idle exit.
 *
 * A handoff changes who serves the socket, so it runs inside the endpoint's ENSURE lock, like an
 * ensure and `host gc`: an ensure arriving meanwhile attaches to whichever generation the handoff
 * left registered, and gc never judges the endpoint halfway through.
 */
import { createDaemonDirectories, createHostDaemonPaths } from "./host-daemon-paths.ts";
import { provenOwner, readHostRegistration } from "./host-daemon-registration.ts";
import { GENERATION_HANDOFF_CAPABILITY } from "./host-decision.ts";
import { acquireHostEnsureLock } from "./host-ensure-lock.ts";
import { STOP_WAIT_BUDGET_MS } from "./host-ensure-stop.ts";
import { handoffUnregisteredHost, SESSION_COUNT_TIMEOUT_MS } from "./host-handoff-unregistered.ts";
import type { HostLifecyclePolicyInput } from "./host-lifecycle.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import { SUCCESSOR_START_BUDGET_MS, startSuccessor } from "./host-successor.ts";

const HANDOFF_PROBE_TIMEOUT_MS = 10_000;

/**
 * The longest a handoff holds the ensure lock: its probe of the running host, the two session counts
 * an unregistered host gets (before the swap and the recount after it), then the successor's start.
 */
export const HANDOFF_LOCK_HOLD_MS = HANDOFF_PROBE_TIMEOUT_MS + 2 * SESSION_COUNT_TIMEOUT_MS + SUCCESSOR_START_BUDGET_MS;

/**
 * How long a handoff waits for the lock. The longest holder is an ensure that probes the running host
 * and then hands it off itself (its upgrade path), or one that waits out a stopped host's stall before
 * starting a replacement; 10 s of headroom for a slow runner.
 */
const HANDOFF_LOCK_WAIT_MS =
	HANDOFF_PROBE_TIMEOUT_MS + Math.max(HANDOFF_LOCK_HOLD_MS, STOP_WAIT_BUDGET_MS + 10_000) + 10_000;

export interface HandoffHostOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Extra CLI arguments the successor's host child is launched with (provider pinning, extensions). */
	readonly hostArgs?: readonly string[];
	/** Environment for the successor; a `null` value removes an inherited variable. */
	readonly env?: Readonly<Record<string, string | null>>;
	/** The runtimeBuildId the successor must compute; set on its environment, never inherited by later daemons. */
	readonly expectedRuntimeBuildId?: string;
	readonly policy?: HostLifecyclePolicyInput;
	/**
	 * How the successor is launched from supervisor argv. Defaults to THIS process's runtime; a
	 * running host performing an idle handover passes the runtime of the CLI that asked for it.
	 */
	readonly launch?: (args: readonly string[]) => { command: string; args: readonly string[] };
	readonly _test?: {
		readonly readinessTimeoutMs?: number;
		/** Builds the spawnable command from supervisor argv; tests point it at the source entry. */
		readonly launch?: (args: readonly string[]) => { command: string; args: readonly string[] };
		/** Runs after the public socket identity is captured and before the successor is spawned. */
		readonly beforeSpawn?: () => Promise<void>;
		/** Runs once the successor is spawned and its generation recorded, before its answer is awaited. */
		readonly afterSpawn?: (pid: number) => Promise<void>;
		/** Runs once the successor answered on the public socket, before the pointer is moved onto it. */
		readonly beforeRegistration?: () => Promise<void>;
		readonly platform?: NodeJS.Platform;
	};
}

/** Why a handoff did not happen. Every one of them leaves the running host untouched. */
export type HandoffRefusal =
	/** Nothing is serving the socket: there is no generation to hand off from. */
	| "no_host"
	/** The running host predates the drain handler; signalling it would kill it. */
	| "handoff_unsupported"
	/** win32: a named pipe can be neither renamed nor drained. */
	| "upgrade_unsupported"
	/** No record proves which process serves this socket, and that host holds sessions (or will not say). */
	| "unknown_owner"
	/** A host from before layout 2, proven by its flat record, holds sessions; `detail` says how to retire it. */
	| "legacy_host"
	/** The public socket stopped being the one this handoff was decided against. */
	| "socket_replaced"
	/** `<public>.next-<gen>` would exceed the platform's socket path limit. */
	| "socket_path_too_long"
	/** The successor never answered on the public socket; it was stopped and nothing was replaced. */
	| "successor_unavailable";

export type HandoffResult =
	| {
			readonly action: "handoff";
			readonly pid: number;
			readonly socket: string;
			readonly generation: number;
			readonly instanceId: string;
	  }
	| {
			readonly action: "refuse";
			readonly reason: HandoffRefusal;
			readonly upgradeable: boolean;
			readonly detail?: string;
	  };

/**
 * Hands the socket to a new generation of this build. Forced by design: the caller decides
 * whether an upgrade is warranted (`decideHostAction`); this performs the one it asked for.
 */
export async function handoffHost(options: HandoffHostOptions): Promise<HandoffResult> {
	if (handoffUnsupported(options)) return { action: "refuse", reason: "upgrade_unsupported", upgradeable: false };
	const release = await acquireHostEnsureLock(options.socket, HANDOFF_LOCK_WAIT_MS);
	try {
		return await handoffHostLocked(options);
	} finally {
		await release();
	}
}

/** The handoff itself, for a caller that already holds this socket's ensure lock: an ensure's upgrade. */
export async function handoffHostLocked(options: HandoffHostOptions): Promise<HandoffResult> {
	if (handoffUnsupported(options)) return { action: "refuse", reason: "upgrade_unsupported", upgradeable: false };
	const paths = createHostDaemonPaths({
		socket: options.socket,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
	});
	await createDaemonDirectories(paths);
	const host = await probeProtocolInfo(options.socket, HANDOFF_PROBE_TIMEOUT_MS);
	if (!host) return { action: "refuse", reason: "no_host", upgradeable: false };
	if (!host.capabilities.includes(GENERATION_HANDOFF_CAPABILITY)) {
		return { action: "refuse", reason: "handoff_unsupported", upgradeable: false };
	}
	const registered = await readHostRegistration(paths);
	const owner = await provenOwner(registered, options.socket);
	if (!owner) return handoffUnregisteredHost(options, paths, host);
	return startSuccessor({ options, paths, host, owner });
}

function handoffUnsupported(options: HandoffHostOptions): boolean {
	return (options._test?.platform ?? process.platform) === "win32";
}
