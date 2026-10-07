/**
 * The vocabulary every `senpi host` answer is written in: the exit codes, the identity fields of a
 * host, and the two ways a request ends without acting. Shared by the request runner and the
 * conditional idle handover, so both report one host the same way.
 */
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import {
	decideHostAction,
	HOST_PROTOCOL_VERSION,
	type HostDecisionClient,
	type HostProtocolInfo,
	REQUIRED_HOST_CAPABILITIES,
} from "./host-decision.ts";
import type { ResolvedHostLaunchSpec } from "./host-launch-spec.ts";
import { hostSummary } from "./host-status.ts";
import { socketHostLaunchProfile } from "./protocol-identity.ts";
import { computeRuntimeBuildId } from "./runtime-build-id.ts";

export const HOST_EXIT_OK = 0;
export const HOST_EXIT_ERROR = 1;
export const HOST_EXIT_USAGE = 2;
export const HOST_EXIT_REFUSED = 3;
export const HOST_EXIT_FALLBACK = 4;

/** One JSON line and the exit code it means. */
export interface HostOutcome {
	readonly exitCode: number;
	readonly payload: Record<string, unknown>;
}

export function identityPayload(
	socket: string,
	pid: number,
	host: HostProtocolInfo | undefined,
): Record<string, unknown> {
	return {
		socket,
		pid,
		instanceId: host?.instanceId ?? null,
		generation: host?.generation ?? null,
		engineVersion: host?.engineVersion ?? null,
		engineOrdinal: host?.engineOrdinal ?? null,
		capabilities: host?.capabilities ?? [],
		launchProfileId: host?.launch_profile?.profile_id ?? null,
		runtimeBuildId: host?.runtimeBuildId ?? null,
		upgradeable: decideHostAction(decisionClient(), host, "upgrade").upgradeable,
	};
}

/**
 * The `runtimeBuildId` a host launched from `spec` by THIS process would report: this process's
 * runtime plus the spec's extensions, through the same launch profile the host derives from its
 * argv. A runtime that cannot be read reports `null` (unverified) rather than failing the request.
 */
export async function clientRuntimeBuildId(spec: ResolvedHostLaunchSpec): Promise<string | null> {
	const profile = socketHostLaunchProfile(spec.hostArgs, process.cwd());
	return computeRuntimeBuildId({ profile: profile.core }).catch((cause: unknown) => {
		process.stderr.write(`senpi host: runtime identity unreadable: ${String(cause)}\n`);
		return null;
	});
}

/**
 * The two ways a request ends without acting, and the exit codes they mean: a `refuse` leaves a
 * running host alone (3), a `fallback` says no host is better than this one (4).
 */
export function refusal(
	kind: "refuse" | "fallback",
	host: HostProtocolInfo | undefined,
	body: { readonly reason: string } & Record<string, unknown>,
): HostOutcome {
	return {
		exitCode: kind === "refuse" ? HOST_EXIT_REFUSED : HOST_EXIT_FALLBACK,
		payload: { action: kind, ...body, host: hostSummary(host) },
	};
}

/**
 * This build as a client, WITHOUT a launch profile: the request's own `ensureHost` decides whether a
 * handoff may happen, from the profile it would launch. What is asked here is only what any client
 * can answer without one - is the running host usable, and could it be handed off from at all.
 */
export function decisionClient(): HostDecisionClient {
	return {
		protocolVersion: HOST_PROTOCOL_VERSION,
		requiredCapabilities: REQUIRED_HOST_CAPABILITIES,
		identity: engineBuildIdentity(),
		startedByUs: false,
		platform: process.platform,
	};
}
