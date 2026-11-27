/**
 * What an ensure may conclude about a registered generation that did not answer: whether its public path still
 * accepts (`EndpointServing`, probed once by the caller), whether the process that registered it is gone, and
 * whether the generation is alive but stalled (senpi#2566, IS-5). Split out of `host-ensure.ts`; no check here
 * ever signals anything.
 */
import { lstat } from "node:fs/promises";
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import type { HostPidFileWriter, RegisteredHost } from "./host-daemon-registration.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";
import { HostEnsureRefusedError, type HostProtocolInfo } from "./host-decision.ts";
import type { EndpointServing } from "./host-endpoint-serving.ts";
import { resolvePidFileOwnership } from "./host-ensure-stop.ts";
import type { HostHolder } from "./host-holder.ts";
import { hostChildAlive, hostLoopStalled, stallRefusalWindowMs } from "./host-stalled-evidence.ts";
import { loopLagErrorMs } from "./loop-lag-threshold.ts";
import { socketEntryListenerState } from "./socket-ownership.ts";

/**
 * IS-5: a generation nothing can reach whose loop is measurably stalled is still serving its sessions, so
 * it is neither stopped nor stranded beside a new generation: no signal, no successor, registration intact.
 */
export async function refuseIfStalled(
	paths: HostDaemonPaths,
	instanceId: string,
	socket: string,
	protocol: HostProtocolInfo | undefined,
): Promise<void> {
	const generation = generationPaths(paths, instanceId);
	const stalled = await hostLoopStalled(generation, {
		now: Date.now(),
		errorMs: loopLagErrorMs(),
		windowMs: stallRefusalWindowMs(),
	});
	if (stalled && (await hostChildAlive(generation)) !== false) {
		throw new HostEnsureRefusedError(socket, "host_stalled", protocol);
	}
}

/**
 * I1 for a record another process wrote: while something still accepts at the public path, the generation
 * it names may own the endpoint, so the ensure refuses `foreign_writer` - and the refusal names that
 * generation, so every client can say WHO is in the way instead of only that something is
 * (omo-desktop-app#3561). An endpoint nothing accepts at (`absent`) is left to the caller's stranded start (#1936).
 */
export async function refuseIfForeignHeld(
	paths: HostDaemonPaths,
	registered: RegisteredHost,
	socket: string,
	protocol: HostProtocolInfo | undefined,
	serving: EndpointServing,
): Promise<void> {
	if (serving === "absent") return;
	const holder = await readHostHolder(paths, registered);
	throw new HostEnsureRefusedError(socket, "foreign_writer", protocol, undefined, holder);
}

/** The registration's own account of the generation: its record also stores the build and launch profile. */
export async function readHostHolder(paths: HostDaemonPaths, registered: RegisteredHost): Promise<HostHolder> {
	const record = parseJson(await readFileOrUndefined(generationPaths(paths, registered.instanceId).pidFile)) ?? {};
	return {
		pid: registered.record.pid,
		instanceId: registered.instanceId,
		generation: registered.generation,
		processStartTime: registered.record.processStartTime,
		engineVersion: typeof record.engineVersion === "string" ? record.engineVersion : null,
		launchProfileId: typeof record.launchProfileId === "string" ? record.launchProfileId : null,
		writerPid: registered.writer?.pid ?? null,
	};
}

/**
 * I1's other carve-out (senpi#4769): a record whose writer is provably gone - its pid is not live, or now belongs to a
 * process started at another time - has nobody left who may end the generation it names. A record with no writer
 * stamp, or one whose identity cannot be read, is never called gone.
 */
export async function writerGone(
	writer: HostPidFileWriter | undefined,
	readStartTime: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
	if (writer === undefined || writer.startTime === null) return false;
	const identity = { pid: writer.pid, processStartTime: writer.startTime };
	return (await resolvePidFileOwnership(identity, readStartTime)) === "gone";
}

/**
 * Whether something stands behind a public path that no registration names: the gate before an
 * ensure would start a host there. Unlike the registered paths' `absent` verdict it also counts a listener
 * that refuses only because its backlog is full (`socketEntryListenerState`), because a start there
 * could only lose the bind; on the registered paths that "not accepting" leads to the stall check (IS-5).
 *
 * An entry that is not a socket is held too (#5280): the start's `prepareSocketPath` never removes one, so
 * a start there could only fail. The connect probe cannot tell: macOS answers ENOTSOCK, but Linux answers
 * ECONNREFUSED, which reads as a dead listener there. The entry is read with `lstat` and never followed: a
 * symlink, dangling or not, is held too (#5294 class), so a planted link can neither read as a missing entry
 * nor steer the probe to the path it names.
 */
export async function unregisteredEndpointHeld(socket: string): Promise<boolean> {
	if (process.platform === "win32" || socket.startsWith("\0")) return false;
	const entry = await lstat(socket).then(
		(found) => (found.isSocket() ? "socket" : "not-socket"),
		(cause: unknown) => (cause instanceof Error && "code" in cause && cause.code === "ENOENT" ? "absent" : "unknown"),
	);
	if (entry === "absent") return false;
	if (entry !== "socket") return true;
	return (await socketEntryListenerState(socket)).verdict === "live";
}
