import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "../../../../config.ts";
import type { SessionManager } from "../../../session-manager.ts";
import type { GoalStoreRef } from "./types.ts";

type GoalStoreSession = Pick<SessionManager, "getSessionFile" | "getSessionDir" | "getSessionId">;

export function goalStoreRef(sessionManager: GoalStoreSession, cwd: string): GoalStoreRef {
	const sessionFile = sessionManager.getSessionFile();
	const baseDir =
		sessionFile === undefined
			? join(getAgentDir(), "extensions", "goal", "no-session", cwdStoreKey(cwd))
			: join(sessionManager.getSessionDir(), "extensions", "goal");

	return {
		baseDir,
		threadId: sessionManager.getSessionId(),
	};
}

function cwdStoreKey(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}
