/** This build as a host client: what it declares to `decideHostAction`, and when a host is compatible with it. */
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import {
	decideHostAction,
	HOST_PROTOCOL_VERSION,
	type HostDecisionClient,
	type HostProtocolInfo,
	REQUIRED_HOST_CAPABILITIES,
} from "./host-decision.ts";
import type { EnsureHostOptions } from "./host-ensure-types.ts";
import { hostLaunchProfile } from "./protocol-identity.ts";

/** This build as a client: which protocol it speaks, what it needs from a host, and which build it is. */
export function ensureClient(options: EnsureHostOptions, startedByUs: boolean): HostDecisionClient {
	return {
		protocolVersion: HOST_PROTOCOL_VERSION,
		requiredCapabilities: REQUIRED_HOST_CAPABILITIES,
		identity: engineBuildIdentity(),
		// An ensure that may upgrade has to say what it would launch: the superset rule refuses to
		// hand off to a generation that would drop what the running host loads. An ensure that may
		// not upgrade declares nothing, and therefore can never be the newer candidate.
		...(options.upgrade === "if-engine-differs"
			? { launchProfile: hostLaunchProfile(hostChildArgv(options.hostArgs ?? []), process.cwd()) }
			: {}),
		startedByUs,
		platform: process.platform,
	};
}

/** The argv the supervisor gives its host child; the launch profile has to describe THAT host. */
export function hostChildArgv(hostArgs: readonly string[]): string[] {
	return ["--mode", "rpc", "--multi-session", ...hostArgs];
}

/**
 * Compatibility, for the attach decision and the readiness gate alike: a host is compatible exactly
 * when a client that is forbidden to upgrade would attach to it. Never a version-string comparison (I2).
 */
export function isCompatible(protocol: HostProtocolInfo | undefined): boolean {
	return decideHostAction(ensureClient({ socket: "" }, false), protocol, "never").action === "reuse";
}
