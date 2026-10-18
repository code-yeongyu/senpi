/**
 * What an ensure may conclude about a registered generation that did not answer: whether anything still
 * accepts at the public path, and whether the generation is alive but stalled (senpi#2566, IS-5). Split
 * out of `host-ensure.ts`; neither check ever signals anything.
 */
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { HostEnsureRefusedError, type HostProtocolInfo } from "./host-decision.ts";
import { probeSocketReachable } from "./host-probe.ts";
import { hostChildAlive, hostLoopStalled, stallRefusalWindowMs } from "./host-stalled-evidence.ts";
import { loopLagErrorMs } from "./loop-lag-threshold.ts";
import { statSocketIdentity } from "./socket-ownership.ts";

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
 * Only the connect matters here, never an answer: the kernel completes it from the listen backlog
 * without the host's event loop, so a live owner under load still accepts within this budget.
 */
const FOREIGN_ENDPOINT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether SOMETHING still accepts connections at the public path - the one fact that says a
 * registered process may still own the endpoint. A missing entry and an entry nobody listens
 * behind (connection refused) both answer no; an accepted connection, however silent, answers yes.
 * A named pipe has no entry to lose and an abstract socket has no path, so both read as owned;
 * so does an entry this process cannot stat, because an owner that cannot be ruled out is one
 * this ensure must not bind over.
 */
export async function publicEndpointAccepts(socket: string): Promise<boolean> {
	if (process.platform === "win32" || socket.startsWith("\0")) return true;
	const entry = await statSocketIdentity(socket).then(
		(identity) => (identity === undefined ? "absent" : "present"),
		() => "unknown",
	);
	if (entry === "absent") return false;
	if (entry === "unknown") return true;
	return probeSocketReachable(socket, FOREIGN_ENDPOINT_PROBE_TIMEOUT_MS);
}
