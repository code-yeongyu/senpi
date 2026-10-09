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

import { createHostDaemonPaths, generationPaths } from "./host-daemon-paths.ts";
import {
	provenOwner,
	readHostRegistration,
	releaseGeneration,
	releaseRegistrationPointer,
} from "./host-daemon-registration.ts";
import { GENERATION_HANDOFF_CAPABILITY } from "./host-decision.ts";
import { provenLegacyOwner } from "./host-legacy.ts";
import { probeProtocolInfo, probeSessionCount } from "./host-probe.ts";
import { writeStopIntent } from "./host-stop-intent.ts";

export interface StopHostOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Ask the host to finish its work and exit (SIGUSR1) instead of terminating it. */
	readonly drain?: boolean;
	/** Terminate even when the host still reports open sessions. */
	readonly force?: boolean;
	readonly timeoutMs?: number;
}

export type StopHostResult =
	| { readonly action: "drained" | "stopped"; readonly pid: number }
	| { readonly action: "refuse"; readonly reason: "unknown_owner" | "drain_unsupported" | "sessions_live" };

/**
 * Ends a running generation. `drain` is always permitted - it ends no work, it only stops the
 * host from taking new work - while a hard stop requires either an empty host or `force`, so an
 * operator never silently kills another client's sessions.
 */
export async function stopHost(options: StopHostOptions): Promise<StopHostResult> {
	const paths = createHostDaemonPaths({
		socket: options.socket,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
	});
	const registered = await readHostRegistration(paths);
	const owner = await provenOwner(registered, options.socket);
	if (options.drain === true) {
		const pid = owner?.pid ?? (await provenLegacyOwner(paths, options.socket))?.pid;
		if (pid === undefined) return { action: "refuse", reason: "unknown_owner" };
		const host = await probeProtocolInfo(options.socket, options.timeoutMs ?? 10_000);
		// SIGUSR1 terminates a process that installed no handler for it: a host that does not
		// advertise the drain is refused rather than killed by the request to shut down gently.
		if (!host?.capabilities.includes(GENERATION_HANDOFF_CAPABILITY) || process.platform === "win32") {
			return { action: "refuse", reason: "drain_unsupported" };
		}
		// A generation that left on its own between the proof and the signal is already drained.
		signalGeneration(pid, "SIGUSR1");
		return { action: "drained", pid };
	}
	if (!owner) return { action: "refuse", reason: "unknown_owner" };
	const host = await probeProtocolInfo(options.socket, options.timeoutMs ?? 10_000);
	// A hard stop ends whatever the host is doing, including work that belongs to other clients:
	// it is allowed only against a host that reports nothing open, or by an explicit override.
	const sessions = await probeSessionCount(options.socket, options.timeoutMs ?? 10_000);
	if (options.force !== true && host !== undefined && sessions !== undefined && sessions > 0) {
		return { action: "refuse", reason: "sessions_live" };
	}
	await writeStopIntent(generationPaths(paths, owner.instanceId), {
		sender: { pid: process.pid, kind: "stop" },
		targetPid: owner.pid,
		reason: "operator_stop",
		signal: "SIGTERM",
		at: new Date().toISOString(),
	});
	const delivered = signalGeneration(owner.pid, "SIGTERM");
	// The signal ended this generation, so the pointer and boot settings go now: a pointer left behind
	// names a process nobody serves with, and the next ensure would read it as a host to probe. The
	// generation DIRECTORY stays for the supervisor, which records its child's end from the intent in
	// it and releases it itself (senpi#2566); one that was already gone leaves it to this call. A
	// DRAINING host keeps its registration - it is still serving - and drops it on the way out itself.
	if (delivered) await releaseRegistrationPointer(paths, owner.instanceId);
	else await releaseGeneration(paths, { instanceId: owner.instanceId, pid: owner.pid });
	return { action: "stopped", pid: owner.pid };
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
