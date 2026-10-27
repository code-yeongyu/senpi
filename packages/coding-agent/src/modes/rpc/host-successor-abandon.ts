/**
 * Undoing a handoff whose successor never published. Split out of `host-successor.ts`: only a successor that can
 * no longer take the public socket (its publication token revoked, or it never received one) is ever abandoned;
 * one that published is repaired forward instead.
 */
import type { ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { generationPaths, HOST_STATE_FILE_MODE, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { releaseGeneration } from "./host-daemon-registration.ts";
import { announceStop, recordEscalation, type StopTarget, signalPid } from "./host-ensure-stop.ts";

/** How long a refused handoff waits for the successor it killed to exit before releasing its record. */
export const SUCCESSOR_EXIT_WAIT_MS = 5_000;

/**
 * Undoes what a refused handoff left: kills the successor, releases its generation once it has exited
 * (a successor that never got a pid never ran, so its directory goes at once; one that outlives the wait
 * keeps its record until pruning finds it dead), and puts the boot settings back as they were. A
 * successor that was never spawned leaves only the boot settings to undo. A cleanup that fails is
 * answered, not thrown: the handoff still refused, and the caller is told why
 * the endpoint may not be as it was.
 */
export async function abandonSuccessor(context: {
	/** Undefined when the successor was never spawned: nothing to kill or release. */
	child: ChildProcess | undefined;
	exited: Promise<void> | undefined;
	paths: HostDaemonPaths;
	instanceId: string;
	bootSettings: string | undefined;
	/** Why the successor is being killed: the stop intent and the record name it. */
	reason: string;
}): Promise<string | undefined> {
	const { child, exited, paths, instanceId, bootSettings } = context;
	const target: StopTarget = {
		daemonDir: paths.dir,
		generation: generationPaths(paths, instanceId),
		instanceId,
		sender: { pid: process.pid, kind: "successor" },
		reason: context.reason,
	};
	// A successor that cannot be asked to stop is killed outright; it runs no exit handler, so the
	// record of it is this process's to write, BEFORE its generation is released below.
	const killed =
		child?.pid !== undefined && child.exitCode === null && child.signalCode === null
			? await announceStop(target, child.pid)
			: undefined;
	if (killed !== undefined && child?.pid !== undefined) signalPid(child.pid, "SIGKILL");
	try {
		if (bootSettings === undefined) await rm(paths.settingsFile, { force: true });
		else await writeFile(paths.settingsFile, bootSettings, { mode: HOST_STATE_FILE_MODE });
		if (child?.pid === undefined) await rm(generationPaths(paths, instanceId).dir, { recursive: true, force: true });
		else if (exited !== undefined && (await exitedWithin(exited, SUCCESSOR_EXIT_WAIT_MS))) {
			if (killed !== undefined) await recordEscalation(target, killed);
			await releaseGeneration(paths, { instanceId, pid: child.pid });
		}
		return undefined;
	} catch (cause) {
		return `successor cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
}

export async function exitedWithin(exited: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([exited.then(() => true), timedOut]);
	} finally {
		clearTimeout(timer);
	}
}
