import type { EvalStatusEvent } from "../../bridge/protocol.ts";
import type { SessionSpawnAttestation } from "@code-yeongyu/senpi";
import { terminateProcessTrees } from "./process-tree-host.ts";

/** How long a lost worker's children get to honour SIGTERM before the host sends SIGKILL. */
const WORKER_LOSS_CHILD_GRACE_MS = 1_000;

/** Live cell children the worker reported; retired by the host when the worker itself is lost. */
export class WorkerChildren {
	readonly #pids = new Map<number, SessionSpawnAttestation | undefined>();
	readonly #collectOrphanedChildren: ((pids: readonly number[]) => Promise<unknown>) | undefined;
	readonly #attest: (pid: number) => SessionSpawnAttestation | undefined;

	constructor(
		collectOrphanedChildren?: (pids: readonly number[]) => Promise<unknown>,
		attest: (pid: number) => SessionSpawnAttestation | undefined = () => undefined,
	) {
		this.#collectOrphanedChildren = collectOrphanedChildren;
		this.#attest = attest;
	}

	track(event: EvalStatusEvent): void {
		const pid = event.pid;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
		if (event.state === "spawned") {
			if (!this.#pids.has(pid)) this.#pids.set(pid, this.#attest(pid));
		} else if (event.state === "exited") {
			void this.#pids.get(pid)?.release();
			this.#pids.delete(pid);
		}
	}

	/**
	 * A terminated or crashed worker never reaches its own cell-end cleanup, so the host retires the
	 * children it still owned; a pid `ps` no longer lists as our child was reused and is skipped.
	 */
	async retire(): Promise<void> {
		if (this.#pids.size === 0) return;
		const pids = [...this.#pids.keys()];
		for (const attestation of this.#pids.values()) void attestation?.release();
		this.#pids.clear();
		await terminateProcessTrees(pids, { graceMs: WORKER_LOSS_CHILD_GRACE_MS, ownerPid: process.pid });
		// The worker that owned these children and their exit watchers is gone, so nothing else will wait on them.
		await this.#collectOrphanedChildren?.(pids);
	}
}
