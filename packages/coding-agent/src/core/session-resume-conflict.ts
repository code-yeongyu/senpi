/** Recoverable rejection: resume admission no longer describes the destination bytes. */
export class SessionResumeConflictError extends Error {
	readonly sessionFile: string;

	constructor(sessionFile: string) {
		super(`Session file changed while preparing resume: ${sessionFile}`);
		this.name = "SessionResumeConflictError";
		this.sessionFile = sessionFile;
	}
}

/** Any preparation failure is recoverable while the outgoing runtime still owns its live session. */
export class SessionResumeRejectedError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "SessionResumeRejectedError";
	}
}
