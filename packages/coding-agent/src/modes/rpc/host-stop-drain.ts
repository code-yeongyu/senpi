/**
 * `stopHost({ drain: true })`: asking a generation to finish its work and leave (senpi#3653).
 *
 * A drain ends no work, so it is permitted against any generation whose record PROVES the process
 * serving this endpoint (pid + start time, I1) - the current one by default, or one NAMED by instance
 * id, which is how a client reaches a superseded generation still holding its sessions' path claims.
 *
 * Two channels exist, and the choice is made on evidence, never on platform:
 *
 * - the drain REQUEST file (host-stop-intent.ts), used whenever the generation advertises it reads
 *   one AND that advertisement names the very pid just proven. It needs no signal, so it is the only
 *   channel a win32 generation has, and the one every current generation is asked through - also one
 *   that only a flat record proves, found through the instance its endpoint answers as;
 * - SIGUSR1, kept for a generation from before the request existed, and only where the signal drains:
 *   POSIX, a host that advertises the legacy `generation_handoff`, and the generation that host actually
 *   is. A named generation the endpoint does not answer as is never signalled, and neither is a host that
 *   admits its own handoffs (senpi#7044): it ignores a bare SIGUSR1 and is always asked through its request.
 *
 * Anything else is refused (`drain_unsupported`) rather than sent a signal whose default disposition
 * would terminate it. `waitMs` turns the request into "drained and gone": the answer then says whether
 * the process exited within the bound, judged only on positive evidence (the pid is gone, or now
 * names a different process); an identity that cannot be read is not an exit.
 */
import {
	ProcessIdentityUnreadableError,
	processIsLive,
	processMatchesPidFile,
	readProcessStartTime,
} from "../../utils/process-identity.ts";
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import {
	isGenerationId,
	provenOwner,
	readGenerationRegistration,
	readHostRegistration,
} from "./host-daemon-registration.ts";
import { handoffSupport } from "./host-decision.ts";
import { provenLegacyOwner } from "./host-legacy.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import { readDrainWatch, writeDrainRequest } from "./host-stop-intent.ts";

export interface DrainHostOptions {
	readonly socket: string;
	/** Drain this generation instead of the one the pointer names. */
	readonly instanceId?: string;
	/** Wait up to this long for the drained generation to exit, and report whether it did. */
	readonly waitMs?: number;
	readonly timeoutMs?: number;
}

export type DrainHostResult =
	| {
			readonly action: "drained";
			readonly pid: number;
			readonly instanceId?: string;
			/** Present when the caller waited: whether the generation's process exited within `waitMs`. */
			readonly exited?: boolean;
	  }
	| { readonly action: "refuse"; readonly reason: "unknown_owner" | "drain_unsupported" };

const EXIT_POLL_MS = 100;

export async function drainHost(paths: HostDaemonPaths, options: DrainHostOptions): Promise<DrainHostResult> {
	const named = options.instanceId;
	if (named !== undefined && !isGenerationId(named)) return { action: "refuse", reason: "unknown_owner" };
	const registered =
		named === undefined ? await readHostRegistration(paths) : await readGenerationRegistration(paths, named);
	const owner = await provenOwner(registered, options.socket);
	if (owner !== undefined && (await askThroughRequest(paths, owner.instanceId, owner.pid))) {
		return drained({ ...owner }, options.waitMs);
	}
	if (named !== undefined && owner === undefined) return { action: "refuse", reason: "unknown_owner" };
	const pid = owner?.pid ?? (await provenLegacyOwner(paths, options.socket))?.pid;
	if (pid === undefined) return { action: "refuse", reason: "unknown_owner" };
	const host = await probeProtocolInfo(options.socket, options.timeoutMs ?? 10_000);
	// A generation only a flat record proves has no registration to name it: the endpoint's own answer does.
	const answering = host?.instanceId;
	if (owner === undefined && answering !== undefined && isGenerationId(answering)) {
		if (await askThroughRequest(paths, answering, pid)) {
			return drained({ pid, processStartTime: undefined }, options.waitMs);
		}
	}
	// SIGUSR1 terminates a process that installed no handler for it, and a host that admits its own handoffs
	// ignores it: only a POSIX host that advertises the legacy drain, and that is the generation being asked,
	// is signalled.
	const answersAsTarget = named === undefined || answering === named;
	if (host === undefined || handoffSupport(host) !== "legacy" || !answersAsTarget || process.platform === "win32") {
		return { action: "refuse", reason: "drain_unsupported" };
	}
	signalDrain(pid);
	return drained(owner ?? { pid, processStartTime: undefined }, options.waitMs);
}

/** Writes the drain request of the generation `instanceId` when its watch names the proven `pid`; false otherwise. */
async function askThroughRequest(paths: HostDaemonPaths, instanceId: string, pid: number): Promise<boolean> {
	const generation = generationPaths(paths, instanceId);
	if ((await readDrainWatch(generation.drainWatchFile))?.pid !== pid) return false;
	await writeDrainRequest(generation.drainRequestFile, {
		sender: { pid: process.pid, kind: "stop" },
		reason: "operator_drain",
	}).catch((cause: unknown) => {
		// The generation ended and released its directory between the ownership check and this write: it is
		// already drained, and the caller's exit check reports it.
		if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
	});
	return true;
}

async function drained(
	owner: { readonly pid: number; readonly processStartTime: string | undefined; readonly instanceId?: string },
	waitMs: number | undefined,
): Promise<DrainHostResult> {
	const base = {
		action: "drained" as const,
		pid: owner.pid,
		...(owner.instanceId && { instanceId: owner.instanceId }),
	};
	if (waitMs === undefined) return base;
	return { ...base, exited: await waitForExit(owner, waitMs) };
}

async function waitForExit(
	owner: { readonly pid: number; readonly processStartTime: string | undefined },
	waitMs: number,
): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (await exitedNow(owner)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
	}
}

async function exitedNow(owner: {
	readonly pid: number;
	readonly processStartTime: string | undefined;
}): Promise<boolean> {
	if (!processIsLive(owner.pid)) return true;
	if (owner.processStartTime === undefined) return false;
	const identity = { pid: owner.pid, processStartTime: owner.processStartTime };
	return processMatchesPidFile(identity, readProcessStartTime).then(
		(same) => !same,
		(error: unknown) => {
			if (error instanceof ProcessIdentityUnreadableError) return false;
			throw error;
		},
	);
}

/** A generation that left between the proof and the signal is already drained (ESRCH). */
function signalDrain(pid: number): void {
	try {
		process.kill(pid, "SIGUSR1");
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
		throw error;
	}
}
