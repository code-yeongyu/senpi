/**
 * The `get_protocol_info` answer as a CLIENT reads it: the shape, and the tolerant parse that
 * produces it.
 *
 * This is a BOUNDARY: everything past it is typed, and nothing past it re-validates. Every identity
 * field is optional because a host from an older release answers without them, and an absent field
 * stays absent rather than being defaulted - a guessed `0` generation or a guessed ordinal would be
 * a comparison a client could act on, which is precisely what must not happen (I2). The one field
 * that IS defaulted is `protocolVersion`, to `0`, because no client speaks protocol 0: a reply from
 * before the field existed therefore fails closed instead of matching.
 */
import type { EngineOrdinal } from "../../core/engine-build-identity.ts";
import type { RpcLaunchProfile } from "./rpc-types.ts";
import { parseRuntimeBuildId } from "./runtime-build-id.ts";

/**
 * A `get_protocol_info` answer as a CLIENT reads it. Every identity field is optional because a
 * host from an older release answers without them; absence is read as "uncomparable", never as zero.
 */
export interface HostProtocolInfo {
	readonly protocolVersion: number;
	/** Informational only. Nothing in this module compares it. */
	readonly serverVersion: string;
	readonly capabilities: readonly string[];
	/** Which host PROCESS answered. A handoff is complete exactly when this value changes. */
	readonly instanceId?: string;
	/** Which generation of the daemon that process is; `0` until the first handoff. */
	readonly generation?: number;
	readonly engineVersion?: string;
	readonly engineOrdinal?: EngineOrdinal;
	readonly launch_profile?: RpcLaunchProfile;
	/** Whether the answering host's memory sampler reads pressure right now; absent on classic and older hosts. */
	readonly memory_pressure?: boolean;
	/** Content digest of the runtime the host loaded at startup (`sha256:<64 hex>`); absent on older hosts. */
	readonly runtimeBuildId?: string;
	/** The conditional idle handover this host holds, as it reported it. */
	readonly handover?: Readonly<Record<string, unknown>>;
}

/** Parses the `data` of a `get_protocol_info` reply. Unknown or malformed identity fields are dropped, not guessed. */
export function parseHostProtocolInfo(data: unknown): HostProtocolInfo | undefined {
	if (!isRecord(data) || typeof data.serverVersion !== "string") return undefined;
	if (!Array.isArray(data.capabilities) || !data.capabilities.every((entry) => typeof entry === "string")) {
		return undefined;
	}
	const ordinal = parseOrdinal(data.engineOrdinal);
	const launchProfile = parseLaunchProfile(data.launch_profile);
	const runtimeBuildId = parseRuntimeBuildId(data.runtimeBuildId);
	return {
		// A reply without a protocol version predates the field; 0 never matches, so it fails closed.
		protocolVersion: typeof data.protocolVersion === "number" ? data.protocolVersion : 0,
		serverVersion: data.serverVersion,
		capabilities: data.capabilities,
		...(typeof data.instanceId === "string" && { instanceId: data.instanceId }),
		...(typeof data.generation === "number" &&
			Number.isSafeInteger(data.generation) && { generation: data.generation }),
		...(typeof data.engineVersion === "string" && { engineVersion: data.engineVersion }),
		...(ordinal && { engineOrdinal: ordinal }),
		...(launchProfile && { launch_profile: launchProfile }),
		...(typeof data.memory_pressure === "boolean" && { memory_pressure: data.memory_pressure }),
		...(runtimeBuildId !== undefined && { runtimeBuildId }),
		...(isRecord(data.handover) && { handover: data.handover }),
	};
}

function parseOrdinal(value: unknown): EngineOrdinal | undefined {
	if (!Array.isArray(value) || value.length !== 5 || !value.every((part) => typeof part === "number"))
		return undefined;
	return [value[0], value[1], value[2], value[3], value[4]];
}

function parseLaunchProfile(value: unknown): RpcLaunchProfile | undefined {
	if (!isRecord(value) || typeof value.profile_id !== "string" || !isRecord(value.core)) return undefined;
	const { extensions, multi_session, session_runtime } = value.core;
	if (!Array.isArray(extensions) || !extensions.every((entry) => typeof entry === "string")) return undefined;
	if (typeof multi_session !== "boolean") return undefined;
	if (session_runtime !== "in-process" && session_runtime !== "worker") return undefined;
	return { profile_id: value.profile_id, core: { extensions, multi_session, session_runtime } };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
