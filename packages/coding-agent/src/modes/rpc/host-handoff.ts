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
import { getAgentDir } from "../../config.ts";
import {
	type EngineBuildIdentity,
	engineBuildIdentity,
	engineIdentityOf,
	olderEngineDetail,
} from "../../core/engine-build-identity.ts";
import type { Duplex } from "node:stream";
import { createDaemonDirectories, createHostDaemonPaths } from "./host-daemon-paths.ts";
import { provenOwner, readHostRegistration } from "./host-daemon-registration.ts";
import { GENERATION_HANDOFF_CAPABILITY } from "./host-decision.ts";
import { acquireHostEnsureLock } from "./host-ensure-lock.ts";
import { foreignAgentDirRefusal, localForeignAgentDirRefusal } from "./host-handoff-agent-dir.ts";
import { handoffUnregisteredHost } from "./host-handoff-unregistered.ts";
import type { HostLifecyclePolicyInput } from "./host-lifecycle.ts";
import { electPointer } from "./host-pointer-election.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import { isIdentityRefusal, probeOrIdentityRefusal } from "./host-identity-refusal.ts";
import type { HostProtocolInfo } from "./host-protocol-info.ts";
import { childStalledStopMaxMs } from "./host-stalled-evidence.ts";
import { startupEnvelope } from "./host-startup-policy.ts";
import { startSuccessor } from "./host-successor.ts";
import { rpcKeyRoot, withRpcKeyRoot } from "./rpc-auth-client.ts";
import type { RpcEndpointAuthErrorCode } from "./rpc-auth-proof.ts";

const HANDOFF_PROBE_TIMEOUT_MS = 10_000;

export interface HandoffHostOptions {
	/**
	 * The launch owner's enrollment channel. A provider (a running host's deferred handover) is called only when the
	 * successor reaches its presenter phase, so its permit is fresh for the exchange (senpi#4602).
	 */
	readonly presenterBootstrap?: Duplex | (() => Promise<Duplex | undefined>);
	/** Deployment opt-in. An enforcing predecessor never downgrades during replacement. */
	readonly mcpPresenterEnforcement?: boolean;
	readonly socket: string;
	readonly agentDir?: string;
	/** Extra CLI arguments the successor's host child is launched with (provider pinning, extensions). */
	readonly hostArgs?: readonly string[];
	/** Environment for the successor; a `null` value removes an inherited variable. */
	readonly env?: Readonly<Record<string, string | null>>;
	/**
	 * The engine the successor runs. Defaults to THIS process's build; a running host performing an idle handover
	 * passes the engine the requesting CLI stated. A successor strictly older than the running host is refused
	 * `older_engine` unless `allowDowngrade` (senpi#7018).
	 */
	readonly successorEngine?: EngineBuildIdentity;
	/** The caller's explicit consent to hand a newer host down to an older engine. */
	readonly allowDowngrade?: boolean;
	/** The runtimeBuildId the successor must compute; set on its environment, never inherited by later daemons. */
	readonly expectedRuntimeBuildId?: string;
	readonly policy?: HostLifecyclePolicyInput;
	/**
	 * How the successor is launched from supervisor argv. Defaults to THIS process's runtime; a
	 * running host performing an idle handover passes the runtime of the CLI that asked for it.
	 */
	readonly launch?: (args: readonly string[]) => SuccessorLaunch;
	readonly _test?: {
		readonly readinessTimeoutMs?: number;
		/** Builds the spawnable command from supervisor argv; tests point it at the source entry. */
		readonly launch?: (args: readonly string[]) => SuccessorLaunch;
		/** Runs after the public socket identity is captured and before the successor is spawned. */
		readonly beforeSpawn?: () => Promise<void>;
		/** Runs once the successor is spawned and its generation recorded, before its answer is awaited. */
		readonly afterSpawn?: (pid: number) => Promise<void>;
		/** Runs once the successor answered on the public socket, before the pointer is moved onto it. */
		readonly beforeRegistration?: () => Promise<void>;
		readonly platform?: NodeJS.Platform;
	};
}

/** `reportsStartup`: the command is the engine's own supervisor, which reports its startup phases (senpi#4602). */
export interface SuccessorLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly reportsStartup?: boolean;
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
	/** The running host belongs to another agent dir; only a client of that dir may replace it (#3560). */
	| "foreign_agent_dir"
	/** A host from before layout 2, proven by its flat record, holds sessions; `detail` says how to retire it. */
	| "legacy_host"
	/** The public socket stopped being the one this handoff was decided against. */
	| "socket_replaced"
	/** `<public>.next-<gen>` would exceed the platform's socket path limit. */
	| "socket_path_too_long"
	/** The successor never answered on the public socket; it was stopped and nothing was replaced. */
	| "successor_unavailable"
	/** The successor's engine is older than the running host's and the caller did not allow a downgrade. */
	| "older_engine"
	/** The host answered but could not be proven from the caller's key root; nothing was asked of it (omo#15197). */
	| RpcEndpointAuthErrorCode;

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
 * whether an upgrade is warranted (`decideHostAction`); this performs the one it asked for, except
 * a downgrade: a successor whose engine is older than the running host's is refused unless the caller
 * says `allowDowngrade` (senpi#7018), so no caller can hand a newer host down by accident.
 */
export function handoffHost(options: HandoffHostOptions): Promise<HandoffResult> {
	// Its probes prove the target's hosts from the root they publish under, as ensureHost does (omo#15197).
	return withRpcKeyRoot(rpcKeyRoot({}, options.agentDir || undefined), () => handoffHostInKeyRoot(options));
}

async function handoffHostInKeyRoot(options: HandoffHostOptions): Promise<HandoffResult> {
	if (handoffUnsupported(options)) return { action: "refuse", reason: "upgrade_unsupported", upgradeable: false };
	// W: the same bound an ensure waits, covering one compliant holder H (senpi#4602).
	const release = await acquireHostEnsureLock(options.socket, startupEnvelope(childStalledStopMaxMs()).lockWait);
	try {
		return await handoffHostLocked(options);
	} finally {
		await release();
	}
}

/** The handoff itself, for a caller that already holds this socket's ensure lock: an ensure's upgrade. */
export async function handoffHostLocked(requested: HandoffHostOptions): Promise<HandoffResult> {
	if (handoffUnsupported(requested)) return { action: "refuse", reason: "upgrade_unsupported", upgradeable: false };
	// One agent dir for the guard, the daemon paths and the successor's environment alike (an empty
	// string keeps its pre-#3563 meaning: this process's default).
	const options = { ...requested, agentDir: requested.agentDir || getAgentDir() };
	const paths = createHostDaemonPaths({ socket: options.socket, agentDir: options.agentDir });
	// Created before the agent-dir guard on purpose: realpath needs the caller's dir to exist, so a refused
	// foreign caller may leave an empty daemon dir under its own agent dir (harmless).
	await createDaemonDirectories(paths);
	const local = await localForeignAgentDirRefusal(options.socket, options.agentDir);
	if (local) return local;
	const host = await probeOrIdentityRefusal(() => probeProtocolInfo(options.socket, HANDOFF_PROBE_TIMEOUT_MS));
	if (isIdentityRefusal(host))
		return { action: "refuse", reason: host.refused, upgradeable: false, detail: host.detail };
	if (!host) return { action: "refuse", reason: "no_host", upgradeable: false };
	if (!host.capabilities.includes(GENERATION_HANDOFF_CAPABILITY)) {
		return { action: "refuse", reason: "handoff_unsupported", upgradeable: false };
	}
	const downgrade = downgradeRefusal(options, host);
	if (downgrade) return downgrade;
	const foreign = await foreignAgentDirRefusal(options.socket, options.agentDir, host);
	if (foreign) return foreign;
	// A pointer an earlier prune dropped is given back to the one proven live generation (senpi#1911).
	await electPointer(paths);
	const registered = await readHostRegistration(paths);
	const owner = await provenOwner(registered, options.socket);
	if (!owner) return handoffUnregisteredHost(options, paths, host);
	return startSuccessor({ options, paths, host, owner });
}

function downgradeRefusal(options: HandoffHostOptions, host: HostProtocolInfo): HandoffResult | undefined {
	if (options.allowDowngrade === true || host.engineOrdinal === undefined) return undefined;
	const running = engineIdentityOf(host.engineVersion ?? "", host.engineOrdinal);
	const detail = olderEngineDetail(options.successorEngine ?? engineBuildIdentity(), running);
	return detail === undefined ? undefined : { action: "refuse", reason: "older_engine", upgradeable: false, detail };
}

function handoffUnsupported(options: HandoffHostOptions): boolean {
	return (options._test?.platform ?? process.platform) === "win32";
}
