import type { RpcSessionEntry } from "./session-registry.ts";
import { RpcSessionRegistryError } from "./session-registry.ts";

export interface SessionTeardownHost {
	readonly closeGraceMs: number;
	get(handle: string): RpcSessionEntry | undefined;
	delete(handle: string): void;
	releaseReservation(key: string): void;
	sync(): void;
}

function reportDetachedFailure(handle: string, cause: unknown): void {
	process.stderr.write(`senpi rpc session ${handle} teardown failed: ${String(cause)}\n`);
}

export function beginSessionClose(
	host: SessionTeardownHost,
	handle: string,
	onRole?: (finalizer: boolean) => void,
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
	entry.state = "closing";
	onRole?.(true);
	entry.closeCompletion = new Promise<void>((resolve) => {
		entry.closeResolve = resolve;
	});
	return entry;
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
	const closeScopeOnce = async (): Promise<void> => {
		if (scopeClosed) return;
		scopeClosed = true;
		await entry.scope.close?.();
	};
	const release = (): void => {
		if (released) return;
		released = true;
		if (releaseTimer) clearTimeout(releaseTimer);
		entry.state = "closed";
		host.delete(handle);
		if (entry.reservationKey) host.releaseReservation(entry.reservationKey);
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
	const finish = (): void => {
		if (settled) return;
		settled = true;
		release();
		entry.closeResolve?.();
	};
	releaseTimer = setTimeout(() => {
		void disposeOnce().catch((cause) => reportDetachedFailure(handle, cause));
		void closeScopeOnce().catch((cause) => reportDetachedFailure(handle, cause));
		void graceful.catch((cause) => reportDetachedFailure(handle, cause));
		finish();
	}, host.closeGraceMs);

	void graceful.then(finish, (cause) => {
		reportDetachedFailure(handle, cause);
		finish();
	});
	return completion;
}
