/** This build as a host client: what it declares to `decideHostAction`, and when a host is compatible with it. */
import { isToolRuntimeKind, toolRuntimeCapability } from "../../cli/tool-runtime.ts";
import {
	comparableEngines,
	type EngineBuildIdentity,
	engineBuildIdentity,
	engineIdentityOf,
} from "../../core/engine-build-identity.ts";
import {
	decideHostAction,
	HOST_PROTOCOL_VERSION,
	type HostDecision,
	type HostDecisionClient,
	type HostProtocolInfo,
	REQUIRED_HOST_CAPABILITIES,
} from "./host-decision.ts";
import type { EnsureHostOptions } from "./host-ensure-types.ts";
import { isHostGenerationProcess } from "./host-process-role.ts";
import { hostLaunchProfile } from "./protocol-identity.ts";

/** An ensure must produce a host; an unavailable upgrade falls back to a compatible attachment. */
export function decideEnsureAction(
	options: EnsureHostOptions,
	startedByUs: boolean,
	protocol: HostProtocolInfo | undefined,
): Exclude<HostDecision, { action: "fallback" }> {
	if (options.upgrade !== "if-engine-differs" || isHostGenerationProcess())
		return decideHostAction(ensureClient(options, startedByUs), protocol, "never");
	const client = ensureClient(options, startedByUs);
	const decision = decideHostAction(client, protocol, "upgrade");
	const ensured: Exclude<HostDecision, { action: "fallback" }> =
		decision.action === "fallback" ? { action: "reuse", reason: "compatible", upgradeable: false } : decision;
	if (ensured.action === "reuse") reportUncomparableEngine(client.identity, protocol);
	return ensured;
}

/**
 * An upgrade that could not be judged is said out loud (senpi#7040): a host whose engine ordinal is not senpi
 * CalVer (a compiled omo through 5.1.78 advertised its omo version) is never ordered against this build, so it is
 * kept whichever engine is newer. Said only for a host this ensure keeps: a refused host is not kept (senpi#7058).
 */
function reportUncomparableEngine(client: EngineBuildIdentity, host: HostProtocolInfo | undefined): void {
	if (host?.engineOrdinal === undefined) return;
	const running = engineIdentityOf(host.engineVersion ?? "", host.engineOrdinal);
	if (comparableEngines(client, running)) return;
	process.stderr.write(
		`senpi host: engine order uncomparable: this build ${client.text} [${client.ordinal.join(",")}], the running host ${running.text} [${running.ordinal.join(",")}]; only senpi CalVer ordinals are ordered, so the running host is kept\n`,
	);
}

/** This build as a client: which protocol it speaks, what it needs from a host, and which build it is. */
export function ensureClient(options: EnsureHostOptions, startedByUs: boolean): HostDecisionClient {
	return {
		protocolVersion: HOST_PROTOCOL_VERSION,
		requiredCapabilities: [...REQUIRED_HOST_CAPABILITIES, ...requestedToolRuntime(options.hostArgs ?? [])],
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

/**
 * An explicit `--tool-runtime` in `hostArgs` is a requirement (senpi#3566): a host advertising another runtime - or none,
 * because it predates the flag - is not reused for this client. Without the flag the client requires nothing new.
 */
export function requestedToolRuntime(hostArgs: readonly string[]): string[] {
	for (let index = 0; index < hostArgs.length; index++) {
		const arg = hostArgs[index] ?? "";
		const value =
			arg === "--tool-runtime"
				? hostArgs[index + 1]
				: arg.startsWith("--tool-runtime=")
					? arg.slice("--tool-runtime=".length)
					: undefined;
		if (value !== undefined && isToolRuntimeKind(value)) return [toolRuntimeCapability(value)];
	}
	return [];
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
