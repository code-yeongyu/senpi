/**
 * The ensure's answer to a registered generation whose pid is alive but which did not answer the protocol probe.
 * Every branch decides on ONE serving probe of the public path (`probeEndpointServing`, senpi#4769): a host is
 * judged by whether its socket can serve, never by its pid alone. Split out of `host-ensure.ts`.
 */
import type { HostDaemonPaths } from "./host-daemon-paths.ts";
import { generationPaths } from "./host-daemon-paths.ts";
import type { RegisteredHost } from "./host-daemon-registration.ts";
import { HostEnsureRefusedError, type HostProtocolInfo } from "./host-decision.ts";
import { probeEndpointServing } from "./host-endpoint-serving.ts";
import { refuseIfForeignHeld, refuseIfStalled, writerGone } from "./host-ensure-liveness.ts";
import { DEFAULT_STOP_TIMEOUT_MS } from "./host-ensure-start.ts";
import { ensureSender, stopManagedHost } from "./host-ensure-stop.ts";
import type { EnsureHostOptions } from "./host-ensure-types.ts";
import { readProcessStartTime } from "../../utils/process-identity.ts";

/**
 * Resolves to the generation a fresh start must leave running beside it (stranded), or `undefined` once the
 * generation was stopped; throws the refusal when neither is allowed.
 */
export async function settleUnansweredGeneration(input: {
	readonly paths: HostDaemonPaths;
	readonly socket: string;
	readonly registered: RegisteredHost;
	readonly protocol: HostProtocolInfo | undefined;
	readonly startedByUs: boolean;
	readonly options: EnsureHostOptions;
}): Promise<RegisteredHost | undefined> {
	const { paths, socket, registered, protocol } = input;
	const testOptions = input.options._test;
	const probe = testOptions?.readProcessStartTime ?? readProcessStartTime;
	const serving = await probeEndpointServing(socket, testOptions?.servingProbeClock);
	// I1: only the process that WROTE this record may end its generation. When that writer is provably gone and the
	// socket accepts but can never serve, nobody else can: its listener keeps the path, so no fresh generation can
	// bind beside it either, and every client stays locked out until someone stops it by hand (senpi#4769).
	const managed = input.startedByUs || (serving === "unserved" && (await writerGone(registered.writer, probe)));
	if (!managed) {
		// The socket is silent, but the process behind it is alive. Anyone else refuses rather than signalling
		// somebody else's host.
		await refuseIfForeignHeld(paths, registered, socket, protocol, serving);
		await refuseIfStalled(paths, registered.instanceId, socket, protocol);
		// A foreign record whose public endpoint accepts NOTHING names a generation nobody can reach: its entry
		// was replaced (so it is already draining, #1893) or removed, or a dead listener left the entry behind.
		// Refusing here locked every client out until that process happened to exit (#1936). Binding a fresh
		// generation there signals nothing, so that is what happens - the stranded one keeps its record.
		return registered;
	}
	// Silent is not the same as gone. A host serving many sessions can miss a probe budget while its event loop
	// is busy; its socket still ACCEPTS and holds the connection. Ending it then would destroy every live session
	// to replace a host that was never broken, so a socket that holds or answers is refused instead of signalled.
	if (serving === "held" || serving === "answered") throw new HostEnsureRefusedError(socket, "host_busy", protocol);
	await refuseIfStalled(paths, registered.instanceId, socket, protocol);
	await stopManagedHost(
		registered.record,
		testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
		{
			daemonDir: paths.dir,
			generation: generationPaths(paths, registered.instanceId),
			instanceId: registered.instanceId,
			sender: ensureSender(),
			reason: "replace_unreachable",
		},
		probe,
	);
	return undefined;
}
