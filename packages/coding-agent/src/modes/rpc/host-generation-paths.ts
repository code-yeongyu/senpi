/**
 * One GENERATION's files inside an endpoint's daemon directory, and the error every daemon-state path
 * reports. Split out of `host-daemon-paths.ts` (senpi#2566), which re-exports every name here.
 */
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HostDaemonDirectory } from "./host-daemon-paths.ts";

const DIRECTORY_MODE = 0o700;

export interface HostGenerationPaths {
	readonly dir: string;
	/** Where the pointer names this generation: relative to the daemon directory holding it. */
	readonly relativeDir: string;
	readonly pidFile: string;
	readonly settingsFile: string;
	readonly scratchDir: string;
	/** The host CHILD's `{pid, processStartTime}`, so its liveness is readable apart from the supervisor's. */
	readonly childPidFile: string;
	/** Written by whoever is about to signal this generation, BEFORE the signal (host-stop-intent.ts). */
	readonly stopIntentFile: string;
	/** The newest stall the host's loop-lag watchdog measured (host-stalled-evidence.ts). */
	readonly stalledFile: string;
	/** The host loop's heartbeat: refreshed on every healthy watchdog tick. */
	readonly aliveFile: string;
	/** The supervisor's own report that it is waiting out a stalled child before escalating. */
	readonly stopProgressFile: string;
}

export function generationPaths(paths: HostDaemonDirectory, instanceId: string): HostGenerationPaths {
	const dir = join(paths.generationsDir, instanceId);
	return {
		dir,
		relativeDir: `generations/${instanceId}`,
		pidFile: join(dir, "host.pid"),
		settingsFile: join(dir, "settings.json"),
		scratchDir: join(dir, "scratch"),
		childPidFile: join(dir, "host-child.pid"),
		stopIntentFile: join(dir, "stop-intent.json"),
		stalledFile: join(dir, "host-stalled.json"),
		aliveFile: join(dir, "host-alive.json"),
		stopProgressFile: join(dir, "stop-progress.json"),
	};
}

/** A daemon directory that cannot be created or written, named so the caller can say WHICH path failed. */
export class HostDaemonStateError extends Error {
	readonly path: string;

	constructor(path: string, cause: unknown) {
		super(`RPC daemon state directory ${path} is not usable: ${cause instanceof Error ? cause.message : cause}`, {
			cause,
		});
		this.name = "HostDaemonStateError";
		this.path = path;
	}
}

/** Creates one generation's private directory. Same failure shape as the daemon directory itself. */
export async function createGenerationDirectory(generation: HostGenerationPaths): Promise<void> {
	try {
		await mkdir(generation.scratchDir, { recursive: true, mode: DIRECTORY_MODE });
		await chmod(generation.dir, DIRECTORY_MODE);
	} catch (cause) {
		throw new HostDaemonStateError(generation.dir, cause);
	}
}
