import type { SupervisorActivity, SupervisorOwner } from "./host-lifecycle-activity.ts";

/** Idle and lifetime-owner checks share one ticker and never overlap owner probes. */
export function startSupervisorTicker(options: {
	readonly idleExitMs: number;
	readonly activity: SupervisorActivity;
	readonly owner: SupervisorOwner;
	readonly draining: () => boolean;
	readonly shuttingDown: () => boolean;
	readonly shutdown: (reason: string, exitCode: number) => Promise<never>;
}): () => void {
	const { activity, owner, draining, shuttingDown, shutdown } = options;
	const tickIntervalMs = Math.max(20, Math.min(1_000, options.idleExitMs / 4));
	let ownerCheck = false;
	const ticker = setInterval(() => {
		if (!draining() && activity.refresh() === "exit" && activity.clients.unclassifiedCount === 0)
			void shutdown("idle", 0);
		if (!ownerCheck && !shuttingDown() && !draining()) {
			ownerCheck = true;
			void owner
				.shouldExit(activity)
				.then((exit) => {
					if (exit && !shuttingDown() && !draining()) void shutdown("owner_gone", 0);
				})
				.finally(() => {
					ownerCheck = false;
				});
		}
	}, tickIntervalMs);
	return () => {
		clearInterval(ticker);
		owner.stop();
	};
}
