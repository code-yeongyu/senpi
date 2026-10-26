/**
 * Ending a generation on purpose - the one path where a client may signal a host it did not spawn.
 *
 * Two different acts hide behind "stop the daemon". A DRAIN ends no work: the host stops accepting,
 * finishes what it is doing and exits when it is empty, so it is always permitted against a host
 * that advertises it can survive the signal at all. A HARD STOP ends whatever the host is doing,
 * including the sessions of every other client sharing it, so it is permitted only against a host
 * that reports nothing open - or behind an explicit `force`, which is the operator saying they know.
 *
 * Both are gated on the same proof: the registration must name the process serving THIS socket
 * (pid plus identity guard). An owner nobody can prove is refused rather than signalled (I1). A host
 * from before layout 2 is known only through its flat record (`host-legacy.ts`); that record proves
 * it for a drain, never for a hard stop (#2423).
 *
 * The proof cannot close one race, and `signalGeneration` is where that is handled: a host is free
 * to exit between the moment its identity is proven and the moment the signal is sent - a drained
 * generation reaches its empty-exit within milliseconds of being asked to drain - so the delivery
 * failure ESRCH means "already gone", not "something went wrong", and must never surface as a raw
 * error to a caller that asked for exactly that outcome.
 */

import { createHostDaemonPaths, generationPaths, sameEndpoint } from "./host-daemon-paths.ts";
import { provenOwner, readHostRegistration, releaseGeneration } from "./host-daemon-registration.ts";
import { acquireHostEnsureLock } from "./host-ensure-lock.ts";
import { electPointer } from "./host-pointer-election.ts";
import { probeProtocolInfo, probeSessionCount } from "./host-probe.ts";
import type { HostProtocolInfo } from "./host-protocol-info.ts";
import { type DrainHostResult, drainHost } from "./host-stop-drain.ts";
import { compareStopGeneration, type HostStopGeneration } from "./host-stop-generation.ts";
import { writeStopIntent } from "./host-stop-intent.ts";
import { startedBeforeRegistration } from "./host-stop-start-time.ts";

export interface StopHostOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Ask the host to finish its work and exit instead of terminating it (host-stop-drain.ts). */
	readonly drain?: boolean;
	/** With `drain`: the generation to ask, by instance id, instead of the one the pointer names. */
	readonly instanceId?: string;
	/** With `drain`: wait up to this long for the generation to exit, and report `exited`. */
	readonly waitMs?: number;
	/** Terminate even when the host still reports open sessions. */
	readonly force?: boolean;
	readonly timeoutMs?: number;
	/** Refuse unless the host answers both reads: a caller that judged it idle must not stop it unseen. */
	readonly requireAnswer?: boolean;
	/** Refuse rather than signal a generation other than the one the operator confirmed. */
	readonly expectedGeneration?: HostStopGeneration;
}

export type StopHostResult =
	| DrainHostResult
	| { readonly action: "stopped"; readonly pid: number }
	| {
			readonly action: "refuse";
			readonly reason: "unknown_owner" | "drain_unsupported" | "sessions_live" | "stale_generation";
	  };

/**
 * Ends a running generation. `drain` is always permitted - it ends no work, it only stops the
 * host from taking new work - while a hard stop requires either an empty host or `force`, so an
 * operator never silently kills another client's sessions.
 */
export async function stopHost(options: StopHostOptions): Promise<StopHostResult> {
	// A binding names the generation a HARD stop may signal; a drain targets its own instance and must not hold the lock.
	if (options.expectedGeneration !== undefined && options.drain === true)
		throw new TypeError("stopHost: expectedGeneration binds a hard stop and cannot be combined with drain");
	// GC already holds this lock and uses an unqualified stop. Conditional operator stops acquire it
	// here so ensure/handoff cannot publish a different generation between the check and signal.
	if (options.expectedGeneration === undefined) return stopHostLocked(options);
	const release = await acquireHostEnsureLock(options.socket, 30_000);
	try {
		return await stopHostLocked(options);
	} finally {
		await release();
	}
}

async function stopHostLocked(options: StopHostOptions): Promise<StopHostResult> {
	const paths = createHostDaemonPaths({
		socket: options.socket,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
	});
	// A pointer an earlier prune dropped is given back to the one proven live generation (senpi#1911).
	await electPointer(paths);
	const expected = options.expectedGeneration;
	if (expected !== undefined) {
		const refusal = generationRefusal(compareStopGeneration(await readHostRegistration(paths), expected));
		if (refusal !== undefined) return refusal;
	}
	if (options.drain === true) {
		return drainHost(paths, {
			socket: options.socket,
			...(options.instanceId !== undefined && { instanceId: options.instanceId }),
			...(options.waitMs !== undefined && { waitMs: options.waitMs }),
			...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
		});
	}
	const owner =
		expected === undefined ? await provenOwner(await readHostRegistration(paths), options.socket) : undefined;
	if (expected === undefined && !owner) return { action: "refuse", reason: "unknown_owner" };
	const host = await probeProtocolInfo(options.socket, options.timeoutMs ?? 10_000);
	// A hard stop ends whatever the host is doing, including work that belongs to other clients:
	// it is allowed only against a host that reports nothing open, or by an explicit override.
	const sessions = await probeSessionCount(options.socket, options.timeoutMs ?? 10_000);
	if (options.force !== true && host !== undefined && sessions !== undefined && sessions > 0) {
		return { action: "refuse", reason: "sessions_live" };
	}
	if (options.requireAnswer === true && (host === undefined || sessions === undefined)) {
		return { action: "refuse", reason: "sessions_live" };
	}
	const target = expected === undefined ? owner : await recheckedTarget(paths, options.socket, expected, host);
	if (target === undefined) return { action: "refuse", reason: "unknown_owner" };
	if ("action" in target) return target;
	await writeStopIntent(generationPaths(paths, target.instanceId), {
		sender: { pid: process.pid, kind: "stop" },
		targetPid: target.pid,
		reason: "operator_stop",
		signal: "SIGTERM",
		at: new Date().toISOString(),
	});
	const delivered = signalGeneration(target.pid, "SIGTERM");
	// A signal is not an exit: only the supervisor may release ownership after reaping its host.
	// Its circuit breaker deliberately leaves these records intact while the child might be alive.
	if (!delivered) await releaseGeneration(paths, { instanceId: target.instanceId, pid: target.pid });
	return { action: "stopped", pid: target.pid };
}

type StopRefusal = Extract<StopHostResult, { action: "refuse" }>;

function generationRefusal(match: ReturnType<typeof compareStopGeneration>): StopRefusal | undefined {
	if (match === "stale") return { action: "refuse", reason: "stale_generation" };
	if (match === "unprovable") return { action: "refuse", reason: "unknown_owner" };
	return undefined;
}

/**
 * Refuses a binding the endpoint no longer matches, before any probe or census (desktop#3561 review): a
 * caller learns its confirmation is stale rather than that the host it no longer names is busy.
 */
export async function staleStopGeneration(
	socket: string,
	agentDir: string | undefined,
	expected: HostStopGeneration,
): Promise<StopRefusal | undefined> {
	const paths = createHostDaemonPaths({ socket, ...(agentDir ? { agentDir } : {}) });
	return generationRefusal(compareStopGeneration(await readHostRegistration(paths), expected));
}

/**
 * The confirmed generation re-read after the probes, and the only pid/instance the stop may signal: the
 * expected identity itself, never a registration read that was not compared with it.
 */
async function recheckedTarget(
	paths: ReturnType<typeof createHostDaemonPaths>,
	socket: string,
	expected: HostStopGeneration,
	host: HostProtocolInfo | undefined,
): Promise<StopRefusal | { readonly pid: number; readonly instanceId: string } | undefined> {
	const current = await readHostRegistration(paths);
	const match = compareStopGeneration(current, expected);
	const refusal = generationRefusal(match);
	if (refusal !== undefined) return refusal;
	if (match === "proven" && !(await provenOwner(current, socket))) return undefined;
	if (match === "bound_without_start_time") {
		// No start time was recorded (Windows), so prove the same process another way before signalling: this
		// endpoint, a live process that started before it wrote this registration (a later start is a reused pid),
		// and, when the host answered, the confirmed instance.
		if (current?.socket !== undefined && !sameEndpoint(current.socket, socket)) return undefined;
		if (!(await startedBeforeRegistration(expected.pid, generationPaths(paths, expected.instanceId).pidFile)))
			return undefined;
		if (host?.instanceId !== undefined && host.instanceId !== expected.instanceId)
			return { action: "refuse", reason: "stale_generation" };
	}
	return { pid: expected.pid, instanceId: expected.instanceId };
}

/**
 * Signals a generation whose owner was just proven, and reports whether the signal was delivered.
 *
 * `false` means the process was gone before the signal landed - the one outcome the ownership proof
 * cannot rule out, because nothing stops a host from exiting in between. Callers want that reported,
 * not thrown: every caller here is asking the host to leave, and a host that already left satisfied
 * the request. Any OTHER signalling failure (EPERM against somebody else's process) still throws.
 */
export function signalGeneration(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(pid, signal);
		return true;
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}
