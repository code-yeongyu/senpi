import { APP_NAME } from "../config.ts";

export interface SessionHolder {
	readonly pid: number;
	readonly cwd: string | undefined;
}

export class SessionHeldError extends Error {
	readonly code = "ESESSIONHELD" as const;
	readonly sessionFile: string;
	readonly holders: readonly SessionHolder[];

	constructor(sessionFile: string, holders: readonly SessionHolder[]) {
		const who = holders.map((h) => (h.cwd ? `pid ${h.pid} in ${h.cwd}` : `pid ${h.pid}`)).join("; ");
		super(`This session is open in another ${APP_NAME} process (${who}). Quit it there, then try again.`);
		this.name = "SessionHeldError";
		this.sessionFile = sessionFile;
		this.holders = holders;
	}
}

export class SessionMovingError extends Error {
	readonly code = "ESESSIONMOVING" as const;
	readonly moverPid: number | undefined;

	constructor(sessionFile: string, moverPid: number | undefined) {
		const who = moverPid === undefined ? "another process" : `another process (pid ${moverPid})`;
		super(`Session ${sessionFile} is being moved by ${who}. Try again in a moment.`);
		this.name = "SessionMovingError";
		this.moverPid = moverPid;
	}
}

export class SessionMovedError extends Error {
	readonly code = "ESESSIONMOVED" as const;

	constructor(sessionFile: string) {
		super(`Session ${sessionFile} no longer exists: another process moved it. Resume it from its new location.`);
		this.name = "SessionMovedError";
	}
}
