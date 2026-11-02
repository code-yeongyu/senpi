/**
 * The session worker owns its session JSONL through a file lock. Losing that lock while running
 * (an event-loop stall past the stale window lets another worker reclaim it) means a second owner
 * may already be appending to the same file, so this worker must stop at once rather than keep
 * writing. Closing the harness could flush more entries, so the stop reports `worker_failed` to the
 * server (bounded, so a dead control socket cannot hold the process open) and exits.
 */
export const OWNERSHIP_LOST_REPORT_TIMEOUT_MS = 1_000;

export interface OwnershipLossStop {
	report(message: string): Promise<void>;
	exit(code: number): void;
	reportTimeoutMs?: number;
}

export function stopWorkerOnLostOwnership(stop: OwnershipLossStop): (error: Error) => void {
	let stopping = false;
	return (error) => {
		if (stopping) return;
		stopping = true;
		const message = `Session worker lost its session lock (${(error as NodeJS.ErrnoException).code ?? error.name}); stopping so a second owner is not overwritten`;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, stop.reportTimeoutMs ?? OWNERSHIP_LOST_REPORT_TIMEOUT_MS);
		});
		void Promise.race([stop.report(message).catch(() => {}), timedOut]).finally(() => {
			clearTimeout(timer);
			stop.exit(1);
		});
	};
}
