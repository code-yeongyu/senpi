import { existsSync, statSync } from "node:fs";

export interface SessionCwdIssue {
	sessionFile?: string;
	sessionCwd: string;
	fallbackCwd: string;
}

interface SessionCwdSource {
	getCwd(): string;
	getSessionFile(): string | undefined;
}

export function getMissingSessionCwdIssue(
	sessionManager: SessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionCwd = sessionManager.getCwd();
	if (!sessionCwd || existsSync(sessionCwd)) {
		return undefined;
	}

	return {
		sessionFile,
		sessionCwd,
		fallbackCwd,
	};
}

export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
	return `cwd from session file does not exist\n${issue.sessionCwd}\n\ncontinue in current cwd\n${issue.fallbackCwd}`;
}

export class MissingSessionCwdError extends Error {
	readonly issue: SessionCwdIssue;

	constructor(issue: SessionCwdIssue) {
		super(formatMissingSessionCwdError(issue));
		this.name = "MissingSessionCwdError";
		this.issue = issue;
	}
}

/** A session cwd that exists but is not a folder (a file, a socket): its tools could not run there. */
export interface SessionCwdNotDirectoryIssue {
	sessionFile?: string;
	sessionCwd: string;
}

export class SessionCwdNotDirectoryError extends Error {
	readonly issue: SessionCwdNotDirectoryIssue;

	constructor(issue: SessionCwdNotDirectoryIssue) {
		const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
		super(`Session working directory is not a directory: ${issue.sessionCwd}${sessionFile}`);
		this.name = "SessionCwdNotDirectoryError";
		this.issue = issue;
	}
}

export function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void {
	const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
	if (issue) {
		throw new MissingSessionCwdError(issue);
	}
	const sessionCwd = sessionManager.getCwd();
	// A missing cwd is the case above (or a session with no file, which keeps today's behaviour); one that exists must be a folder.
	if (sessionCwd && statSync(sessionCwd, { throwIfNoEntry: false })?.isDirectory() === false) {
		const sessionFile = sessionManager.getSessionFile();
		throw new SessionCwdNotDirectoryError({ ...(sessionFile ? { sessionFile } : {}), sessionCwd });
	}
}
