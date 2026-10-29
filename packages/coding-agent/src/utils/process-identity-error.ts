/** Thrown when a live process refuses to yield an identity after the retry budget. */
export class ProcessIdentityUnreadableError extends Error {
	readonly pid: number;
	readonly attempts: number;
	override readonly cause: unknown;

	constructor(pid: number, attempts: number, cause: unknown) {
		super(
			`process identity for live pid ${pid} stayed unreadable after ${attempts} probe attempt(s): ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "ProcessIdentityUnreadableError";
		this.pid = pid;
		this.attempts = attempts;
		this.cause = cause;
	}
}
