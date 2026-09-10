/** Recoverable rejection: resume admission no longer describes the destination bytes. */
export class SessionResumeConflictError extends Error {
	readonly sessionFile: string;

	constructor(sessionFile: string) {
		super(`Session file changed while preparing resume: ${sessionFile}`);
		this.name = "SessionResumeConflictError";
		this.sessionFile = sessionFile;
	}
}
