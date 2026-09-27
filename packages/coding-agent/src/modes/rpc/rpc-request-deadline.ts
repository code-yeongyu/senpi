/** How long any request waits for the host's answer - for an open, for its `queued` acknowledgement. */
export const REQUEST_DEADLINE_MS = 30_000;

/**
 * How long an open the host acknowledged with `queued` may take to answer. The host is building the
 * session on its loop, which on a loaded in-process host was measured at ~57 s; a lost transport
 * still rejects at once, so this ceiling only bounds a host that accepted and then went silent
 * (senpi#2209).
 */
export const OPEN_AFTER_QUEUED_DEADLINE_MS = 10 * 60_000;

export function openStalledMessage(position: unknown): string {
	const queued = typeof position === "number" ? ` at queue position ${position}` : "";
	const minutes = OPEN_AFTER_QUEUED_DEADLINE_MS / 60_000;
	return `open_session was accepted by the host${queued} but not answered within ${minutes} minutes`;
}

export interface RequestDeadline {
	/** Restarts the wait with a new budget and the message it fails with. */
	extend(ms: number, message: () => string): void;
	clear(): void;
}

export function armRequestDeadline(ms: number, message: () => string, expire: (error: Error) => void): RequestDeadline {
	let timer = setTimeout(() => expire(new Error(message())), ms);
	return {
		extend(nextMs, nextMessage) {
			clearTimeout(timer);
			timer = setTimeout(() => expire(new Error(nextMessage())), nextMs);
		},
		clear() {
			clearTimeout(timer);
		},
	};
}
