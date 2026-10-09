import type { RpcSessionEntry } from "./session-registry.ts";
import { RpcSessionRegistryError } from "./session-registry.ts";

export interface SessionTeardownHost {
	readonly closeGraceMs: number;
	get(handle: string): RpcSessionEntry | undefined;
	delete(handle: string): void;
	releaseReservation(key: string): Promise<void>;
	/** Publishes that this path is retained with no client attached, for the cross-generation claim. */
	markDetached(key: string): void;
	/** The registry's clock, so the detach stamp shares the sweep's timeline. */
	now(): number;
	sync(): void;
}

/** Session-owned work that outlives its client: a turn, a tool, anything still appending records. */
function sessionIsWriting(entry: RpcSessionEntry): boolean {
	return entry.worker?.busy === true || entry.runtime?.session.isSessionBusy === true;
}

function reportDetachedFailure(handle: string, cause: unknown): void {
	process.stderr.write(`senpi rpc session ${handle} teardown failed: ${String(cause)}\n`);
}

export function beginSessionClose(
	host: SessionTeardownHost,
	handle: string,
	onRole?: (finalizer: boolean) => void,
	options?: { detach?: boolean },
): RpcSessionEntry {
	const entry = host.get(handle);
	if (!entry) throw new RpcSessionRegistryError("unknown_session");
	if (entry.state === "closing") {
		onRole?.(false);
		return entry;
	}
	if (entry.state !== "open") throw new RpcSessionRegistryError("unknown_session");
	entry.attachments -= 1;
	if (entry.attachments > 0) return entry;
	// Retention splits "the last client left" from "the session ends". A detach of a
	// retained session releases the attachment and stops there: the entry stays open
	// with zero attachments, keeps its runtime, its in-flight turn and its path
	// reservation, and is torn down only by an explicit close or the idle window.
	if (options?.detach && entry.retainOnDisconnect) {
		entry.attachments = 0;
		entry.detachedAt ??= host.now();
		// A retained session nobody is attached to is what another generation may reclaim the path
		// from (#1893) - but only once nothing is still WRITING it. A session mid-turn keeps its claim
		// until it parks, because reclaiming it would put two writers on one transcript.
		if (entry.reservationKey && !sessionIsWriting(entry)) host.markDetached(entry.reservationKey);
		return entry;
	}
	entry.state = "closing";
	onRole?.(true);
	entry.closeCompletion = new Promise<void>((resolve) => {
		entry.closeResolve = resolve;
	});
	return entry;
}

/**
 * Close waits for the claim file to be gone, but a removal that never settles (a wedged mount)
 * must not hold the close past the grace window: the close completes and the failure is reported.
 */
export async function releaseWithinGrace(
	host: Pick<SessionTeardownHost, "closeGraceMs" | "releaseReservation">,
	handle: string,
	key: string,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<"late">((resolve) => {
		timer = setTimeout(() => resolve("late"), host.closeGraceMs);
	});
	const removal = host.releaseReservation(key).then(
		() => "removed" as const,
		(cause: unknown) => {
			reportDetachedFailure(handle, cause);
			return "failed" as const;
		},
	);
	const outcome = await Promise.race([removal, late]);
	clearTimeout(timer);
	if (outcome === "late") {
		reportDetachedFailure(
			handle,
			new Error(`session path reservation was not removed within ${host.closeGraceMs} ms; closing anyway`),
		);
	}
}

export function closeSession(host: SessionTeardownHost, handle: string): Promise<void> {
	const entry = beginSessionClose(host, handle);
	if (entry.state !== "closing") return Promise.resolve();
	return closeMarkedSession(host, handle);
}

export function closeMarkedSession(host: SessionTeardownHost, handle: string): Promise<void> {
	host.sync();
	const entry = host.get(handle);
	if (entry?.state !== "closing") throw new RpcSessionRegistryError("unknown_session");
	const completion = entry.closeCompletion;
	if (!completion) return Promise.resolve();
	if (entry.closeStarted) return completion;
	entry.closeStarted = true;

	const previousLifecycle = entry.lifecycleMutex;
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	let released = false;
	let disposePromise: Promise<void> | undefined;
	let scopeClosed = false;
	const disposeOnce = (): Promise<void> => {
		if (disposePromise) return disposePromise;
		disposePromise = Promise.resolve(entry.runtime?.dispose());
		return disposePromise;
	};
	// The scope is what the runtime's shutdown handlers still look providers up in, so it
	// closes only once disposal has settled - however disposal ended, and on the grace path
	// too. Closing it beside a running disposal made every scope-bound callback of the
	// session throw "Provider scope is closed" and leaked the watchers dispose was about to
	// stop (senpi#1905).
	const closeScopeOnce = async (): Promise<void> => {
		if (scopeClosed) return;
		scopeClosed = true;
		await disposeOnce().catch(() => undefined);
		await entry.scope.close?.();
	};
	const release = async (): Promise<void> => {
		if (released) return;
		released = true;
		if (releaseTimer) clearTimeout(releaseTimer);
		if (entry.reservationKey) await releaseWithinGrace(host, handle, entry.reservationKey);
		entry.state = "closed";
		host.delete(handle);
	};
	const graceful = (async (): Promise<void> => {
		await previousLifecycle;
		try {
			await entry.runtime?.session.abort();
		} catch (cause) {
			reportDetachedFailure(handle, cause);
		}
		try {
			await entry.runtime?.session.waitForIdle();
		} catch (cause) {
			reportDetachedFailure(handle, cause);
		}
		try {
			await disposeOnce();
		} catch (cause) {
			reportDetachedFailure(handle, cause);
		}
		try {
			await closeScopeOnce();
		} catch (cause) {
			reportDetachedFailure(handle, cause);
		}
	})();
	let settled = false;
	const finish = async (): Promise<void> => {
		if (settled) return;
		settled = true;
		await release();
		entry.closeResolve?.();
	};
	releaseTimer = setTimeout(() => {
		void disposeOnce().catch((cause) => reportDetachedFailure(handle, cause));
		void closeScopeOnce().catch((cause) => reportDetachedFailure(handle, cause));
		void graceful.catch((cause) => reportDetachedFailure(handle, cause));
		void finish();
	}, host.closeGraceMs);

	void graceful.then(finish, (cause) => {
		reportDetachedFailure(handle, cause);
		return finish();
	});
	return completion;
}
