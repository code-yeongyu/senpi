/**
 * The supervisor's part in a coordinated startup (senpi#4602, A-amended sections 1-3): it reports its own
 * milestones on the startup pipe, relays its host child's, records the attempt nonce in its own generation
 * directory for recovery, and - because the launcher's controller now decides when a start has failed -
 * retries a silent internal-readiness probe or a failed first observer connection inside the attempt's
 * budget instead of ending the generation on the first 10 s / 5 s miss. An uncoordinated supervisor keeps
 * its original limits exactly.
 */
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Readable } from "node:stream";
import { relayHostStartupEvents, reportStartupMilestone, startupHandOff } from "./host-startup-beacon.ts";
import { waitForListener } from "./host-lifecycle-proxy.ts";
import { writeJsonAtomic } from "./host-state-json.ts";
import { STARTUP_ATTEMPT_FILE, STARTUP_EVENT_FD, withStartupPipe } from "./host-startup-wire.ts";

const UNCOORDINATED_LISTENER_TIMEOUT_MS = 30_000;
const OBSERVER_RETRY_DELAY_MS = 250;

/** Declared before the host child is spawned: a custom child command cannot report its own progress. */
export function declareHostChild(childCommand: string | undefined): void {
	if (childCommand) reportStartupMilestone("host_opaque");
}

/** Whether the host child gets the startup pipe: only a coordinated launch of the engine's own host. */
export function hostChildReportsStartup(childCommand: string | undefined): boolean {
	return startupHandOff() !== undefined && !childCommand;
}

export async function hostChildSpawned(
	child: ChildProcess,
	generationDir: string,
	supervisorStartTime: string | undefined,
): Promise<void> {
	const handOff = startupHandOff();
	if (!handOff) return;
	const stream: unknown = (child.stdio as readonly unknown[])[STARTUP_EVENT_FD];
	relayHostStartupEvents(stream instanceof Readable ? stream : undefined);
	await writeJsonAtomic(join(generationDir, STARTUP_ATTEMPT_FILE), {
		attempt: handOff.binding.attempt,
		pid: process.pid,
		processStartTime: supervisorStartTime ?? null,
	});
	reportStartupMilestone("supervisor_setup");
}

export async function awaitInternalStartup(options: {
	readonly internalSocket: string;
	readonly internalSecret: Uint8Array | undefined;
	readonly internalKey: Buffer | undefined;
	readonly openObserver: () => Promise<void>;
}): Promise<void> {
	const handOff = startupHandOff();
	const deadline = performance.now() + (handOff?.budgetMs ?? 0);
	await waitForListener(
		options.internalSocket,
		handOff?.budgetMs ?? UNCOORDINATED_LISTENER_TIMEOUT_MS,
		options.internalSecret,
		options.internalKey,
		{ retrySilent: handOff !== undefined },
	);
	reportStartupMilestone("internal_ready");
	for (;;) {
		try {
			await options.openObserver();
			break;
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : "";
			const unproven = reason === "host_identity_unproven" || reason === "auth_failed";
			if (!handOff || unproven || performance.now() + OBSERVER_RETRY_DELAY_MS >= deadline) throw cause;
			await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, OBSERVER_RETRY_DELAY_MS));
		}
	}
	reportStartupMilestone("observer_ready");
}

export function supervisorPublished(): void {
	reportStartupMilestone("public_published");
}

/**
 * The host child's stdio: stdin for the internal key, inherited stderr, the lifetime pipe at 3, the presenter
 * channel at 4 when bootstrapped, and on a coordinated start the startup pipe at 16 with its fillers.
 */
export function hostChildStdio(bootstrap: boolean, reportsStartup: boolean) {
	const base = [
		process.platform === "win32" ? "ignore" : "pipe",
		"ignore",
		"inherit",
		"pipe",
		...(bootstrap ? ["pipe" as const] : []),
	] as const;
	return reportsStartup ? withStartupPipe(base) : { stdio: [...base], fillers: [] as number[] };
}
