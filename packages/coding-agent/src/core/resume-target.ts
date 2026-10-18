import { resolvePath } from "../utils/paths.ts";
import { resolveMovedPath } from "./extensions/builtin/moved-path-guard/resolve.ts";
import { type RepositoryIdentity, readRepositoryIdentity } from "./repository-identity.ts";
import { classifySessionRepository, readSessionCwd, rebindSessionFile } from "./session-rebind.ts";

export interface ResumeTargetChoice {
	readonly sessionPath: string;
	readonly cwd: string;
	readonly sessionDir?: string;
	readonly confirm: (sessionCwd: string) => Promise<boolean>;
	readonly readIdentity?: (dir: string) => Promise<RepositoryIdentity | undefined>;
}

export interface ResumeTarget {
	readonly path: string;
	readonly rebound: boolean;
}

function sessionCwdOf(sessionPath: string): string | undefined {
	try {
		return readSessionCwd(sessionPath);
	} catch (error) {
		if (error instanceof Error) return undefined;
		throw error;
	}
}

/**
 * Where a session picked for resuming should be opened from. A session of the current repository
 * recorded at another path is offered the in-place rebind; declining, another repository, or the
 * current directory's own session open the picked file unchanged. Rebind failures propagate
 * (`SessionHeldError` names the process still holding the session).
 */
export async function resolveResumeTarget(choice: ResumeTargetChoice): Promise<ResumeTarget> {
	const unchanged: ResumeTarget = { path: choice.sessionPath, rebound: false };
	const sessionCwd = sessionCwdOf(choice.sessionPath);
	// A session whose cwd the OmO desktop moved here is this directory's own session, not one to rebind (senpi#2990).
	if (sessionCwd === undefined || resolvePath(resolveMovedPath(sessionCwd)) === resolvePath(choice.cwd))
		return unchanged;
	const match = await classifySessionRepository(
		choice.sessionPath,
		sessionCwd,
		choice.cwd,
		choice.readIdentity ?? readRepositoryIdentity,
	);
	if (match !== "same" || !(await choice.confirm(sessionCwd))) return unchanged;
	return { path: await rebindSessionFile(choice.sessionPath, choice.cwd, choice.sessionDir), rebound: true };
}
