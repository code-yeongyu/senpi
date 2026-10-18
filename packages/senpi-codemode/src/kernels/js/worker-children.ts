import type { EvalStatusEvent } from "../../bridge/protocol.ts";
import { terminateProcessTrees } from "./process-tree-host.ts";

/** How long a lost worker's children get to honour SIGTERM before the host sends SIGKILL. */
const WORKER_LOSS_CHILD_GRACE_MS = 1_000;

/** Live cell children the worker reported; retired by the host when the worker itself is lost. */
export class WorkerChildren {
	readonly #pids = new Set<number>();
	readonly #collectOrphanedChildren: ((pids: readonly number[]) => Promise<unknown>) | undefined;

	constructor(collectOrphanedChildren?: (pids: readonly number[]) => Promise<unknown>) {
		this.#collectOrphanedChildren = collectOrphanedChildren;
	}

	track(event: EvalStatusEvent): void {
		const pid = event.pid;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
		if (event.state === "spawned") this.#pids.add(pid);
		else if (event.state === "exited") this.#pids.delete(pid);
	}

	/**
	 * A terminated or crashed worker never reaches its own cell-end cleanup, so the host retires the
	 * children it still owned; a pid `ps` no longer lists as our child was reused and is skipped.
	 */
	async retire(): Promise<void> {
		if (this.#pids.size === 0) return;
		const pids = [...this.#pids];
		this.#pids.clear();
		await terminateProcessTrees(pids, { graceMs: WORKER_LOSS_CHILD_GRACE_MS, ownerPid: process.pid });
		// The worker that owned these children and their exit watchers is gone, so nothing else will wait on them.
		await this.#collectOrphanedChildren?.(pids);
	}
}
