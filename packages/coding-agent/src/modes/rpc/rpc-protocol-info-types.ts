import type { PathIdentityResolverStatus } from "./path-identity-status.ts";
import type { SessionRuntimeKind } from "../../cli/args.ts";

import type { EngineOrdinal } from "../../core/engine-build-identity.ts";

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

/**
 * What a host was launched with. `extensions` are absolute roots, deduplicated and
 * sorted, so two hosts that loaded the same set produce the same bytes regardless of
 * the order their launchers passed them.
 */
export interface RpcLaunchProfileCore {
	readonly extensions: readonly string[];
	readonly multi_session: boolean;
	readonly session_runtime: SessionRuntimeKind;
}

/** `profile_id` = sha256 of the canonical JSON of `core` (keys sorted); any client can recompute it. */
export interface RpcLaunchProfile {
	readonly profile_id: string;
	readonly core: RpcLaunchProfileCore;
}

/**
 * Host identity. Compatibility and upgrade decisions are made from these fields -
 * `protocolVersion`, `capabilities` and `engineOrdinal` - NEVER from `serverVersion`,
 * which is informational only.
 */
export interface RpcProtocolIdentity {
	/** UUID minted at host boot; it changes when the host process does, including on a handoff. */
	readonly instanceId: string;
	/** Generation of this host within its daemon directory; 0 when nobody ensured it. */
	readonly generation: number;
	/** Engine build text: the package version plus `+<buildEpoch>.<sha7>` when the build defined them. */
	readonly engineVersion: string;
	/** `[year, month, day, postRelease, buildEpoch]`, compared with `compareEngineOrdinal`. */
	readonly engineOrdinal: EngineOrdinal;
	readonly launch_profile: RpcLaunchProfile;
	/** Absolute agent directory this host reads and writes; a handoff from another agent dir is refused. */
	readonly agentDir: string;
}

export interface RpcProtocolInfo extends RpcProtocolIdentity {
	/** Present only on a public POSIX endpoint's answer to a challenge (wire contract v1.1). */
	readonly auth?: {
		readonly launch_id: string;
		readonly server_nonce: string;
		readonly server_proof: string;
	};
	/** Supervised socket hosts expose admission state independently of child responsiveness. */
	readonly lifecycle?: "ready" | "stopping";
	readonly protocolVersion: 1;
	/** Informational engine version. Never compare it for compatibility - use the fields above. */
	readonly serverVersion: string;
	readonly capabilities: string[];
	readonly mode: "classic" | "multi";
	/**
	 * Multi-session hosts only: whether this host's memory sampler currently reads its memory footprint above
	 * `SENPI_RPC_HOST_RSS_WARN_MB` (the state `host_memory_pressure` records announce). Observability only.
	 */
	readonly memory_pressure?: boolean;
	/** Multi-session hosts only: whether the permission system's path identity worker started, and why not. */
	readonly path_identity_resolver?: PathIdentityResolverStatus;
}
