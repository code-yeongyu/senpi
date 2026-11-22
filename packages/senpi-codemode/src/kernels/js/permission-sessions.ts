import {
	cellAuthority,
	isPermissionSessionHandle,
	type PermissionSessionHandle,
} from "../shared/cell-authority-registry.ts";

interface SessionKernel {
	revoke(): void;
	retire(): Promise<void>;
}

/**
 * One session's permission state as a kernel bound to it sees it. The state is shared by every codemode copy in the
 * realm (omo#12965): a session one copy marked dead, or is revoking, reads so in every copy.
 */
export interface PermissionSession {
	dead: boolean;
	readonly pending: Promise<void> | undefined;
}

/** The revocation in flight, `undefined` for none, `"unreadable"` for a value another copy shaped differently. */
function pendingOf(handle: PermissionSessionHandle): Promise<void> | undefined | "unreadable" {
	const pending: unknown = handle.pending();
	return pending === undefined || pending instanceof Promise ? pending : "unreadable";
}

/**
 * A session whose handle this copy cannot read is dead: its kernels refuse instead of running unrevocable. The view
 * has one shape for every handle, so nothing a holder assigns can make an unreadable one read live.
 */
function sessionView(handle: unknown): PermissionSession {
	const readable = isPermissionSessionHandle(handle) ? handle : undefined;
	return {
		get dead() {
			return readable === undefined || readable.dead() !== false || pendingOf(readable) === "unreadable";
		},
		set dead(value: boolean) {
			if (value) readable?.markDead();
		},
		get pending() {
			const pending = readable === undefined ? undefined : pendingOf(readable);
			return pending === "unreadable" ? undefined : pending;
		},
	};
}

export function registerPermissionKernel(sessionId: string, kernel: SessionKernel): PermissionSession {
	return sessionView(cellAuthority.registerKernel(sessionId, kernel));
}

export function unregisterPermissionKernel(sessionId: string, kernel: SessionKernel): void {
	cellAuthority.unregisterKernel(sessionId, kernel);
}

/** All words go DEAD synchronously, before retirement or another admission can run, in every copy's kernels. */
export function revokeSessionKernels(sessionId: string): Promise<void> {
	return cellAuthority.revoke(sessionId);
}
