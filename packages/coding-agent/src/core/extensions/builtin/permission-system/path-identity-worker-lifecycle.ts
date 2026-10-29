import type { AbandonedWorkerCount } from "./path-identity-breaker.ts";
import type { ResolverReply, ResolverSnapshotMessage } from "./path-identity-protocol.ts";
import type { ResolverTransport } from "./path-identity-transport.ts";

interface WorkerHandle {
	readonly transport: ResolverTransport;
	live: boolean;
	started: boolean;
}

export interface WorkerLifecycleDeps {
	readonly spawn: () => ResolverTransport;
	readonly abandoned: AbandonedWorkerCount;
	onSnapshot(message: ResolverSnapshotMessage): void;
	onReply(reply: ResolverReply): void;
	/** Every pending request is rejected with this detail when the serving worker is gone. */
	rejectAll(detail: string): void;
	/** Called once when a worker fails before it ever started; the lifecycle is then permanently unavailable. */
	onUnavailable(detail: string): void;
}

export interface WorkerLifecycle {
	readonly unavailable: string | undefined;
	readonly live: ResolverTransport | undefined;
	/** The live transport, spawning one when none is live and the cap and the unavailable state allow it. */
	ensure(): ResolverTransport | undefined;
	/** Rejects every pending request, drops the worker and tracks its termination as possibly abandoned. */
	retire(detail: string): void;
	/** Drops every worker and marks the lifecycle unavailable, once. */
	markUnavailable(detail: string): void;
	drop(): WorkerHandle | undefined;
}

function detailOf(error: unknown): string {
	return String((error as { code?: unknown }).code ?? (error as Error).message ?? error);
}

/**
 * A worker that fails before publishing its first snapshot never started: a missing or broken module,
 * not a wedge. That is permanent, so it is reported once and every request is answered at once with
 * EUNAVAILABLE instead of waiting out a deadline; the service then keeps path rules on their literal routes.
 */
export function createWorkerLifecycle(deps: WorkerLifecycleDeps): WorkerLifecycle {
	let worker: WorkerHandle | undefined;
	let unavailable: string | undefined;

	const markUnavailable = (detail: string) => {
		if (unavailable !== undefined) return;
		unavailable = detail;
		worker = undefined;
		deps.onUnavailable(detail);
	};

	const attach = (transport: ResolverTransport): WorkerHandle => {
		const handle: WorkerHandle = { transport, live: true, started: false };
		worker = handle;
		transport.onError((error) => {
			if (worker !== handle || handle.started) return;
			handle.live = false;
			markUnavailable(detailOf(error));
		});
		transport.onMessage((message) => {
			if (worker !== handle) return;
			if ("type" in message) {
				handle.started = true;
				deps.onSnapshot(message);
				return;
			}
			deps.onReply(message);
		});
		transport.onExit(() => {
			if (worker !== handle) return;
			handle.live = false;
			if (!handle.started) {
				markUnavailable("worker exited before it started");
				return;
			}
			worker = undefined;
			deps.rejectAll("resolver worker exited");
		});
		return handle;
	};

	return {
		get unavailable() {
			return unavailable;
		},
		get live() {
			return worker?.live ? worker.transport : undefined;
		},
		ensure() {
			if (worker?.live) return worker.transport;
			if (unavailable !== undefined || deps.abandoned.atCap) return undefined;
			try {
				return attach(deps.spawn()).transport;
			} catch (error) {
				markUnavailable(detailOf(error));
				return undefined;
			}
		},
		retire(detail) {
			const current = worker;
			worker = undefined;
			deps.rejectAll(detail);
			if (!current) return;
			current.live = false;
			deps.abandoned.track(current.transport.terminate());
		},
		markUnavailable,
		drop() {
			const current = worker;
			worker = undefined;
			return current;
		},
	};
}
