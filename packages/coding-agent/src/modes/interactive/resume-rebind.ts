import { REBIND_PROMPT } from "../../cli/cross-project-session.ts";
import { markMovedSessions, withMovedSessions } from "../../core/moved-sessions.ts";
import { resolveResumeTarget } from "../../core/resume-target.ts";
import { type SessionInfo, type SessionListProgress, SessionManager } from "../../core/session-manager.ts";

type SessionScopeSource = Pick<SessionManager, "getCwd" | "getSessionDir" | "usesDefaultSessionDir">;

export interface ResumeRebindUi {
	readonly confirm: (title: string, message: string) => Promise<boolean>;
	readonly showError: (message: string) => void;
}

function sharedSessionDir(source: SessionScopeSource): { readonly sessionDir?: string } {
	return source.usesDefaultSessionDir() ? {} : { sessionDir: source.getSessionDir() };
}

export function currentScopeSessions(
	source: SessionScopeSource,
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	const cwd = source.getCwd();
	return withMovedSessions(
		SessionManager.list(cwd, source.getSessionDir(), onProgress, signal),
		cwd,
		sharedSessionDir(source),
	);
}

export async function allScopeSessions(
	source: SessionScopeSource,
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	const sessions = source.usesDefaultSessionDir()
		? await SessionManager.listAll(onProgress, signal)
		: await SessionManager.listAll(source.getSessionDir(), onProgress, signal);
	return markMovedSessions(sessions, source.getCwd());
}

/** The path `/resume` should open for a picked session, or undefined when moving it failed (already reported). */
export async function chooseResumePath(
	sessionPath: string,
	source: SessionScopeSource,
	ui: ResumeRebindUi,
): Promise<string | undefined> {
	const cwd = source.getCwd();
	try {
		const target = await resolveResumeTarget({
			sessionPath,
			cwd,
			...sharedSessionDir(source),
			confirm: (sessionCwd) =>
				ui.confirm(
					REBIND_PROMPT,
					`Session found in different project: ${sessionCwd}\nThis directory is the same git repository: ${cwd}\nChoose No to open it where it is.`,
				),
		});
		return target.path;
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		ui.showError(`Could not move session: ${error.message}`);
		return undefined;
	}
}
