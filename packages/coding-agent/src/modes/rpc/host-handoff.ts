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
 *   2. the predecessor is then asked to DRAIN: it stops accepting, keeps every connection
 *      it is already proxying, parks each retained session as its turn settles, and exits
 *      through its ordinary idle path;
 *   3. clients that arrive in between reach whichever generation owns the path at that
 *      instant - both are alive and serving.
 *
 * The running host DECIDES whether it is replaced (senpi#7044). One that advertises
 * `handoff_admission` is asked `admit_handoff` before anything is spawned - it refuses a
 * successor older than itself, or one it cannot order - and is drained by presenting that
 * admission over the connection it was granted on (`host-handoff-admission.ts`); it ignores
 * a bare SIGUSR1. A host from before the admission advertises `generation_handoff` instead,
 * cannot be asked, and is drained with SIGUSR1 as it always was; there this requester's own
 * engine check is the only guard, and it stays in front of an admitted handoff as well. Every
 * refusal of this requester's own comes first: the host is asked only for a handoff that is
 * then carried out, so it never admits (and logs) one the requester declines itself.
 *
 * Two guards make this safe rather than merely clever. SIGUSR1 has a DEFAULT DISPOSITION OF
 * TERMINATE, so a host that advertises neither capability is never signalled - it would die,
 * taking its sessions with it. And a host whose pidfile identity cannot be proven is never
 * signalled either (I1), because "the process at this pid" is not evidence.
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
	engineSuccessionRefusal,
} from "../../core/engine-build-identity.ts";
import type { Duplex } from "node:stream";
import { createDaemonDirectories, createHostDaemonPaths } from "./host-daemon-paths.ts";
import { provenOwner, readHostRegistration } from "./host-daemon-registration.ts";
import { handoffSupport } from "./host-decision.ts";
import { acquireHostEnsureLock } from "./host-ensure-lock.ts";
import { type HandoffAdmission, requestHandoffAdmission } from "./host-handoff-admission-request.ts";
import { foreignAgentDirRefusal } from "./host-handoff-agent-dir.ts";
import { handoffUnregisteredHost } from "./host-handoff-unregistered.ts";
import type { HostLifecyclePolicyInput } from "./host-lifecycle.ts";
import { electPointer } from "./host-pointer-election.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import type { HostProtocolInfo } from "./host-protocol-info.ts";
import { childStalledStopMaxMs } from "./host-stalled-evidence.ts";
import { startupEnvelope } from "./host-startup-policy.ts";
import { startSuccessor } from "./host-successor.ts";

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
	 * `older_engine`, one that cannot be ordered against it `unordered_engine`, unless `allowDowngrade` (senpi#7018,
	 * senpi#7044).
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
	/** The running host advertises no way to hand it off: a host from before the drain, or one whose way this client predates. */
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
	/** The successor's engine cannot be ordered against the running host's (an ordinal outside senpi CalVer). */
	| "unordered_engine"
	/** The running host gave no usable answer to the admission request; nothing was spawned. */
	| "not_admitted";

/** Asks the running host to admit this handoff: its admission, or its refusal as this handoff's result. */
export type HandoffAdmit = () => Promise<HandoffAdmission | HandoffResult>;

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
 * a downgrade: a successor whose engine is older than the running host's, or cannot be ordered against
 * it, is refused unless the caller says `allowDowngrade` (senpi#7018), so no caller can hand a newer host
 * down by accident - and the running host, when it can be asked, refuses it as well (senpi#7044).
 */
export async function handoffHost(options: HandoffHostOptions): Promise<HandoffResult> {
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
	const host = await probeProtocolInfo(options.socket, HANDOFF_PROBE_TIMEOUT_MS);
	if (!host) return { action: "refuse", reason: "no_host", upgradeable: false };
	const support = handoffSupport(host);
	if (support === undefined) return { action: "refuse", reason: "handoff_unsupported", upgradeable: false };
	// A host that can be asked is asked LAST, where the successor is about to be started (`startSuccessor`): every
	// refusal of this requester's own runs first. An admission it granted ends with its connection below.
	const admission = support === "admitted" ? heldAdmission(options) : undefined;
	try {
		const downgrade = downgradeRefusal(options, host);
		if (downgrade) return downgrade;
		const foreign = await foreignAgentDirRefusal(options.socket, options.agentDir, host);
		if (foreign) return foreign;
		// A pointer an earlier prune dropped is given back to the one proven live generation (senpi#1911).
		await electPointer(paths);
		const registered = await readHostRegistration(paths);
		const owner = await provenOwner(registered, options.socket);
		const admit = admission?.admit;
		if (!owner) return await handoffUnregisteredHost(options, paths, host, admit);
		return await startSuccessor({ options, paths, host, owner, ...(admit !== undefined && { admit }) });
	} finally {
		admission?.close();
	}
}

/** The admission of one handoff: asked for when the handoff reaches its spawn, and closed with the handoff. */
function heldAdmission(options: HandoffHostOptions): { readonly admit: HandoffAdmit; close(): void } {
	let granted: HandoffAdmission | undefined;
	return {
		admit: async () => {
			const outcome = await admittedByHost(options);
			if (!("action" in outcome)) granted = outcome;
			return outcome;
		},
		close: () => granted?.close(),
	};
}

/** The running host's own verdict on this handoff: the admission it granted, or its refusal as this handoff's. */
async function admittedByHost(options: HandoffHostOptions): Promise<HandoffAdmission | HandoffResult> {
	const outcome = await requestHandoffAdmission(
		options.socket,
		{
			successorEngine: options.successorEngine ?? engineBuildIdentity(),
			allowDowngrade: options.allowDowngrade === true,
		},
		HANDOFF_PROBE_TIMEOUT_MS,
	);
	if (outcome.admitted) return outcome.admission;
	return {
		action: "refuse",
		reason: outcome.reason,
		upgradeable: false,
		...(outcome.detail !== undefined && { detail: outcome.detail }),
	};
}

/** The requester's own check (senpi#7023): the only one a host from before the admission gets. */
function downgradeRefusal(options: HandoffHostOptions, host: HostProtocolInfo): HandoffResult | undefined {
	if (options.allowDowngrade === true || host.engineOrdinal === undefined) return undefined;
	const running = engineIdentityOf(host.engineVersion ?? "", host.engineOrdinal);
	const refusal = engineSuccessionRefusal(options.successorEngine ?? engineBuildIdentity(), running);
	return refusal === undefined ? undefined : { action: "refuse", upgradeable: false, ...refusal };
}

function handoffUnsupported(options: HandoffHostOptions): boolean {
	return (options._test?.platform ?? process.platform) === "win32";
}
