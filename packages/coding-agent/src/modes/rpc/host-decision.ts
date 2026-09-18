/**
 * What a client does when it finds - or does not find - a host on the shared RPC socket.
 *
 * One machine-wide host serves several client surfaces, so the process on the socket is
 * usually NOT this process's child. Two invariants follow, and this module is where they
 * are decided once instead of in every client:
 *
 *   I1 - never terminate, signal or replace a host you did not start. The only sanctioned
 *        replacement is the drain-based generation handoff, which ends no running work.
 *   I2 - compatibility is `protocolVersion` + capabilities, NEVER a version-string compare,
 *        and "is my build newer?" is `compareEngineOrdinal`, never `serverVersion`. An
 *        ordinal that cannot be compared (a build without git metadata, a host that reports
 *        none) is EQUAL, and since a handoff needs STRICTLY greater, such a pair attaches.
 *
 * The profile rule is the third guard: a handoff additionally requires the candidate's
 * extension set to be a SUPERSET of the running host's. Handing off to a narrower generation
 * would silently drop whatever the running host loaded (an editor plugin, a member bundle)
 * from every session that reopens in the new generation - so a narrower candidate attaches
 * and says so instead.
 */
import {
	compareEngineOrdinal,
	type EngineBuildIdentity,
	type EngineOrdinal,
} from "../../core/engine-build-identity.ts";
import {
	EXTENSION_EVENTS_CAPABILITY,
	SESSION_CONTEXT_CAPABILITY,
	SESSION_KIND_CAPABILITY,
} from "./custom-capability.ts";
import type { HostProtocolInfo } from "./host-protocol-info.ts";
import type { RpcLaunchProfile } from "./rpc-types.ts";

export { type HostProtocolInfo, parseHostProtocolInfo } from "./host-protocol-info.ts";

/** The wire protocol this build speaks. A host answering with any other number is refused, not replaced. */
export const HOST_PROTOCOL_VERSION = 1;

/**
 * HOST capability: this host drains into a successor generation on SIGUSR1 instead of dying with
 * its sessions. A host without it is attach-only - it is never renamed, signalled or upgraded.
 */
export const GENERATION_HANDOFF_CAPABILITY = "generation_handoff";

/** What a daemon session needs from a host before any client may attach to it. */
export const REQUIRED_HOST_CAPABILITIES = [
	"multi_session",
	EXTENSION_EVENTS_CAPABILITY,
	SESSION_CONTEXT_CAPABILITY,
	SESSION_KIND_CAPABILITY,
] as const;

export interface HostDecisionClient {
	readonly protocolVersion: number;
	readonly requiredCapabilities: readonly string[];
	readonly identity: EngineBuildIdentity;
	/**
	 * What THIS client would launch a host with. Absent = no launch spec (a bare CLI attaching to
	 * whatever is running): such a client can prove nothing about extensions, so it never hands off.
	 */
	readonly launchProfile?: RpcLaunchProfile;
	/** True when the running host's pidfile records this process as its writer (the I1 question). */
	readonly startedByUs: boolean;
	/** The platform both sides run on - one daemon is machine-local, so the host shares it. */
	readonly platform: NodeJS.Platform;
}

/** `upgrade` may hand off, `fallback` prefers no host over a mismatched one, `never` only attaches. */
export type HostDecisionPolicy = "upgrade" | "fallback" | "never";

export type HostAction = HostDecision["action"];

/** Attached anyway, with something the caller should say out loud. */
export type HostDecisionWarning =
	/** This client's extension set is missing something the host loads; upgrading would drop it. */
	| "profile_narrower_attached"
	/** The profiles differ (or cannot be compared) and no upgrade was possible. */
	| "profile_mismatch_attached";

/** Every action carries only the reasons that can produce it, so an impossible pair cannot be built. */
export type HostDecision =
	| {
			readonly action: "start";
			/** `no_host`: nothing answered. `restart_own_host`: nothing answered and the pidfile is ours. */
			readonly reason: "no_host" | "restart_own_host";
			readonly upgradeable: false;
	  }
	| { readonly action: "refuse"; readonly reason: "protocol" | "capability"; readonly upgradeable: false }
	| {
			readonly action: "fallback";
			readonly reason: "capability" | "engine_mismatch";
			readonly upgradeable: boolean;
	  }
	| {
			readonly action: "reuse";
			/** `handoff_unsupported`: the host predates the drain handoff. `win32_attach_only`: named pipes cannot be renamed and win32 has no SIGUSR1. */
			readonly reason: "compatible" | "handoff_unsupported" | "win32_attach_only";
			/** Whether a generation handoff against this host is possible at all, independent of the policy. */
			readonly upgradeable: boolean;
			readonly warning?: HostDecisionWarning;
	  }
	| { readonly action: "handoff"; readonly reason: "newer_engine" | "profile"; readonly upgradeable: true };

/** What a `never` policy can answer: it attaches, starts or refuses, and never touches a running host. */
export type AttachOnlyDecision = Extract<HostDecision, { action: "start" | "reuse" | "refuse" }>;

/** Why an ensure refused. The decision's own refusals plus the one only a pidfile can produce. */
export type HostRefusalReason = "protocol" | "capability" | "foreign_writer" | "legacy_host" | "host_busy";

/**
 * An ensure that found an unusable host and refused to act on it. A refusal is FINAL by design:
 * this process may not signal a host it did not start (I1), and starting a second host on an
 * endpoint another process already owns is exactly the failure the refusal exists to prevent.
 */
export class HostEnsureRefusedError extends Error {
	readonly socket: string;
	readonly reason: HostRefusalReason;

	constructor(socket: string, reason: HostRefusalReason, host: HostProtocolInfo | undefined) {
		super(`RPC socket ${socket} refused: ${reason} - ${refusalDetail(reason, host)}`);
		this.name = "HostEnsureRefusedError";
		this.socket = socket;
		this.reason = reason;
	}
}

function refusalDetail(reason: HostRefusalReason, host: HostProtocolInfo | undefined): string {
	switch (reason) {
		case "protocol":
			return `the running host speaks protocol version ${host?.protocolVersion ?? "unknown"}, this build speaks ${HOST_PROTOCOL_VERSION}`;
		case "capability": {
			const missing = REQUIRED_HOST_CAPABILITIES.filter((capability) => !host?.capabilities.includes(capability));
			return `the running host is missing ${JSON.stringify(missing)}; it owns the socket, so no second host is started`;
		}
		case "foreign_writer":
			return "its pidfile was written by another process, so this one may not signal it; stop that host explicitly instead";
		case "legacy_host":
			return "a host from before the per-socket daemon directory is still running on this endpoint; it is never signalled, and no second host is started beside it";
		case "host_busy":
			return "its socket accepts connections but did not answer inside the probe budget: a live host under load, which is never ended to make room for a replacement";
		default:
			return assertNever(reason);
	}
}

export function decideHostAction(
	client: HostDecisionClient,
	host: HostProtocolInfo | undefined,
	policy: "never",
): AttachOnlyDecision;
export function decideHostAction(
	client: HostDecisionClient,
	host: HostProtocolInfo | undefined,
	policy: HostDecisionPolicy,
): HostDecision;
export function decideHostAction(
	client: HostDecisionClient,
	host: HostProtocolInfo | undefined,
	policy: HostDecisionPolicy,
): HostDecision {
	if (host === undefined) {
		return { action: "start", reason: client.startedByUs ? "restart_own_host" : "no_host", upgradeable: false };
	}
	if (host.protocolVersion !== client.protocolVersion) {
		return { action: "refuse", reason: "protocol", upgradeable: false };
	}
	if (!client.requiredCapabilities.every((capability) => host.capabilities.includes(capability))) {
		// A host that cannot serve this client still OWNS the socket: starting a second one would
		// bind over an endpoint another process is serving. Refuse, or fall back to no host at all.
		if (policy === "fallback") return { action: "fallback", reason: "capability", upgradeable: false };
		return { action: "refuse", reason: "capability", upgradeable: false };
	}
	const upgradeable = client.platform !== "win32" && host.capabilities.includes(GENERATION_HANDOFF_CAPABILITY);
	if (policy === "fallback" && host.engineVersion !== client.identity.text) {
		return { action: "fallback", reason: "engine_mismatch", upgradeable };
	}
	const warning = profileWarning(client, host);
	if (client.platform === "win32") {
		return { action: "reuse", reason: "win32_attach_only", upgradeable: false, ...(warning && { warning }) };
	}
	if (!upgradeable) {
		return { action: "reuse", reason: "handoff_unsupported", upgradeable: false, ...(warning && { warning }) };
	}
	if (policy === "upgrade" && client.launchProfile && host.launch_profile && supersedes(client, host)) {
		return {
			action: "handoff",
			reason: sameRelease(client.identity.ordinal, host.engineOrdinal) ? "profile" : "newer_engine",
			upgradeable: true,
		};
	}
	return { action: "reuse", reason: "compatible", upgradeable, ...(warning && { warning }) };
}

/** A strictly newer build whose extensions cover everything the host loads - the only handoff candidate. */
function supersedes(client: HostDecisionClient, host: HostProtocolInfo): boolean {
	if (host.engineOrdinal === undefined) return false;
	const hostIdentity: EngineBuildIdentity = {
		text: host.engineVersion ?? "",
		ordinal: host.engineOrdinal,
		scheme: host.engineOrdinal[4] > 0 ? "epoch" : "nodef",
	};
	if (compareEngineOrdinal(client.identity, hostIdentity) <= 0) return false;
	return covers(client.launchProfile, host.launch_profile);
}

function profileWarning(client: HostDecisionClient, host: HostProtocolInfo): HostDecisionWarning | undefined {
	if (client.launchProfile === undefined || host.launch_profile === undefined) return "profile_mismatch_attached";
	if (client.launchProfile.profile_id === host.launch_profile.profile_id) return undefined;
	return covers(client.launchProfile, host.launch_profile) ? "profile_mismatch_attached" : "profile_narrower_attached";
}

function covers(candidate: RpcLaunchProfile | undefined, running: RpcLaunchProfile | undefined): boolean {
	if (candidate === undefined || running === undefined) return false;
	return running.core.extensions.every((extension) => candidate.core.extensions.includes(extension));
}

/** True when both builds are the same released version and only their build epoch differs. */
function sameRelease(candidate: EngineOrdinal, running: EngineOrdinal | undefined): boolean {
	return running !== undefined && candidate.slice(0, 4).every((part, index) => part === running[index]);
}

function assertNever(value: never): never {
	throw new Error(`unreachable host decision: ${JSON.stringify(value)}`);
}
